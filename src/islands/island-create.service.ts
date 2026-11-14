import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { Channel } from '../database/entities/chat.entities';
import { Character } from '../database/entities/character.entities';
import { Island, IslandPoint, Monster, MonsterKind } from '../database/entities/island.entities';
import { Item } from '../database/entities/item.entities';
import { WorldService } from '../world/world.service';
import { ContentFilterService } from '../ai/content-filter.service';
import { AiGatewayService } from '../ai/ai-gateway.service';
import { ResourceRegistryService } from '../resources/resource-registry.service';
import { CharactersService } from '../characters/characters.service';
import { GAME } from '../game/constants';
import {
  DraftIssue,
  IslandDraft,
  islandQuota,
  islandRadius,
  monsterLevelCap,
  threatBudget,
  validateDraft,
} from '../game/m2';
import { distanceNm, round1 } from '../game/geo';
import {
  applyMissingAnswer,
  describeExtraction,
  extractIslandDraft,
  MissingField,
  missingOf,
} from '../game/island-text';

export interface CreateIslandResult {
  island: Island;
  summary: string;
  warnings: string[];
}

interface DraftSession {
  characterId: string;
  draft: Partial<IslandDraft>;
  answers: Record<string, string>;
  questionIndex: number;
  updatedAt: number;
}

interface Question {
  id: string;
  text: string;
  optional: boolean;
  options?: string[];
}

/** 对话式造岛模板（§3）：固定问题 + 按回答追问 */
const QUESTIONS: Question[] = [
  { id: 'name', text: '给你的岛起个名字（2–16 字）。', optional: false },
  { id: 'description', text: '用一句话描述这座岛的样子与氛围。', optional: false },
  {
    id: 'rules',
    text: '写下 3–5 条岛上规则，用「；」或换行分隔（例如：天黑后不要进医院；岛上的淡水归岛主分配）。',
    optional: false,
  },
  {
    id: 'resources',
    text: '岛上的资源方向是什么？例如「废弃加油站，多燃料与零件」或「渔村，多食物与药品」。',
    optional: false,
  },
  { id: 'monsters', text: '岛上有什么怪物？（可用预置种类：溺尸、拾荒者、藤壶蟹；也可自由描述）', optional: false },
  { id: 'max_level', text: '最高怪物等级是多少？（0–7，当前世界日上限会校验）', optional: false },
  { id: 'count', text: '这种怪物大概有几只？（1–12）', optional: false },
  { id: 'concentrated', text: '怪物是分散在岛上，还是集中在某个点？回答「集中」或「分散」。', optional: true },
  { id: 'point_name', text: '如果集中，集中点叫什么？（例如「废弃医院」；不集中就跳过）', optional: true },
  { id: 'buildings', text: '岛上有什么建筑？用「、」分隔，可跳过。', optional: true },
  { id: 'defenses', text: '岛上有什么防御设施？用「、」分隔，可跳过。', optional: true },
  { id: 'weapons', text: '岛主可以架设什么武器？用「、」分隔，可跳过。', optional: true },
];

const FORBIDDEN_RULE_PATTERNS = [
  /本岛.{0,4}无敌/,
  /无法.{0,3}被?攻击/,
  /不受.{0,3}伤害/,
  /无限.{0,2}(资源|生命|血)/,
  /秒杀/,
  /免(伤|疫|死)/,
];

const RESOURCE_LABEL: Record<string, string> = {
  fuel: '燃料',
  food: '食物',
  water: '淡水',
  medicine: '药品',
  part: '零件',
  weapon: '武器',
  tech: '科技件',
  misc: '杂物',
};

@Injectable()
export class IslandCreateService {
  private readonly logger = new Logger(IslandCreateService.name);
  private readonly sessions = new Map<string, DraftSession>();
  private readonly textSessions = new Map<string, { draft: Partial<IslandDraft>; missing: MissingField[]; index: number; updatedAt: number }>();

  constructor(
    @InjectRepository(Island) private readonly islands: Repository<Island>,
    @InjectRepository(IslandPoint) private readonly points: Repository<IslandPoint>,
    @InjectRepository(Monster) private readonly monsters: Repository<Monster>,
    @InjectRepository(MonsterKind) private readonly kinds: Repository<MonsterKind>,
    @InjectRepository(Item) private readonly items: Repository<Item>,
    @InjectRepository(Channel) private readonly channels: Repository<Channel>,
    private readonly world: WorldService,
    private readonly filter: ContentFilterService,
    private readonly resources: ResourceRegistryService,
    private readonly characters: CharactersService,
    private readonly ai: AiGatewayService,
  ) {}

  // ------------------------------------------------------------ 模板会话

  start(characterId: string): { question: Question; index: number; total: number } {
    this.sessions.set(characterId, {
      characterId,
      draft: {},
      answers: {},
      questionIndex: 0,
      updatedAt: Date.now(),
    });
    return { question: QUESTIONS[0], index: 0, total: QUESTIONS.length };
  }

  session(characterId: string): DraftSession | null {
    const session = this.sessions.get(characterId);
    if (!session) return null;
    if (Date.now() - session.updatedAt > 30 * 60_000) {
      this.sessions.delete(characterId);
      return null;
    }
    return session;
  }

  cancel(characterId: string): void {
    this.sessions.delete(characterId);
    this.textSessions.delete(characterId);
  }

  // ------------------------------------------------------------ 一段话造岛

  /** 一段话 → 结构化草稿；只追问缺失项 */
  async startFromText(character: Character, text: string) {
    const extracted = extractIslandDraft(text);
    const draft = await this.aiFill(text, extracted.draft);
    const missing = missingOf(draft);
    this.textSessions.set(character.id, { draft, missing, index: 0, updatedAt: Date.now() });
    const head = describeExtraction({ ...extracted, draft });
    const question = missing[0]?.question ?? null;
    return {
      draft,
      missing,
      complete: missing.length === 0,
      question,
      say: question ? `${head}\n${question}` : `${head}\n信息齐了，回复「确认」就造。`,
    };
  }

  /** 回答一个缺失项，返回下一个问题或汇总 */
  answerMissing(characterId: string, text: string) {
    const session = this.textSessions.get(characterId);
    if (!session) throw new Error('没有正在进行的造岛流程');
    if (Date.now() - session.updatedAt > 30 * 60_000) {
      this.textSessions.delete(characterId);
      throw new Error('造岛流程已超时，重新说「造岛」');
    }
    const current = session.missing[session.index];
    if (!current) return { complete: true, question: null, say: '信息齐了，回复「确认」就造。' };
    applyMissingAnswer(session.draft, current.id, text);
    session.index += 1;
    session.updatedAt = Date.now();
    const next = session.missing[session.index];
    return {
      complete: !next,
      question: next?.question ?? null,
      say: next ? next.question : '信息齐了，回复「确认」就造。',
    };
  }

  textSession(characterId: string) {
    return this.textSessions.get(characterId) ?? null;
  }

  async confirmText(character: Character): Promise<CreateIslandResult> {
    const session = this.textSessions.get(character.id);
    if (!session) throw new Error('没有正在进行的造岛流程');
    if (session.missing.length > session.index) throw new Error('还有信息没补完');
    const result = await this.create(character, session.draft);
    this.textSessions.delete(character.id);
    return result;
  }

  /** 模型补全规则抽不到的字段（失败不影响流程） */
  private async aiFill(text: string, draft: Partial<IslandDraft>): Promise<Partial<IslandDraft>> {
    if (draft.name && draft.description && (draft.rules?.length ?? 0) >= 3 && draft.resource_direction && draft.monsters?.[0]?.name) {
      return draft;
    }
    const prompt = [
      '把玩家对一座岛的描述整理成 JSON，只输出 JSON：',
      '{"name":"","description":"","rules":[""],"resources":"","monster":"","count":0,"max_level":0}',
      `描述：${text.slice(0, 1000)}`,
    ].join('\n');
    try {
      const reply = await this.ai.call('island_extract', prompt, { tier: 'small', maxTokens: 300 });
      const jsonText = /\{[\s\S]*\}/.exec(reply)?.[0];
      if (!jsonText) return draft;
      const parsed = JSON.parse(jsonText) as any;
      if (!draft.name && typeof parsed.name === 'string' && parsed.name.trim()) draft.name = parsed.name.trim().slice(0, 16);
      if (!draft.description && typeof parsed.description === 'string' && parsed.description.trim()) {
        draft.description = parsed.description.trim().slice(0, 120);
      }
      if ((!draft.rules || draft.rules.length < 3) && Array.isArray(parsed.rules)) {
        const rules = parsed.rules.map((rule: any) => String(rule).trim()).filter(Boolean).slice(0, 5);
        if (rules.length >= 3) draft.rules = rules;
      }
      if (!draft.resource_direction && typeof parsed.resources === 'string' && parsed.resources.trim()) {
        draft.resource_direction = parsed.resources.trim().slice(0, 60);
      }
      if (!draft.monsters?.[0]?.name && typeof parsed.monster === 'string' && parsed.monster.trim()) {
        draft.monsters = [
          {
            name: parsed.monster.trim().slice(0, 12),
            max_level: Math.max(0, Math.min(7, Number(parsed.max_level) || 1)),
            count: Math.max(1, Math.min(12, Number(parsed.count) || 3)),
            concentrated: false,
          },
        ];
      }
      return draft;
    } catch (err) {
      this.logger.debug(`造岛模型补充失败：${(err as Error).message}`);
      return draft;
    }
  }

  /** 回答当前问题，返回下一个问题（或 null 表示可以汇总） */
  answer(
    characterId: string,
    questionId: string,
    rawAnswer: string | null,
  ): { next: Question | null; draft: Partial<IslandDraft> } {
    const session = this.session(characterId);
    if (!session) throw new Error('没有正在进行的造岛流程，先发送 island_create_start');
    const current = QUESTIONS[session.questionIndex];
    if (!current) throw new Error('问答已经结束，可以确认创建');
    if (current.id !== questionId) throw new Error(`当前问题是「${current.id}」，请按顺序回答`);

    const text = (rawAnswer ?? '').trim();
    const skipped = text.length === 0 || /^(跳过|skip|-)$/i.test(text);
    if (!current.optional && skipped) throw new Error('这个问题不能跳过');

    session.answers[current.id] = skipped ? '' : text;
    this.applyAnswer(session, current.id, session.answers[current.id]);
    session.updatedAt = Date.now();

    // 「集中」才追问集中点
    if (current.id === 'count') {
      const concentrated = session.answers['concentrated'] ?? '';
      if (!concentrated) {
        session.questionIndex = QUESTIONS.findIndex((q) => q.id === 'concentrated');
        return { next: QUESTIONS[session.questionIndex], draft: session.draft };
      }
    }

    session.questionIndex += 1;
    const next = QUESTIONS[session.questionIndex] ?? null;
    return { next, draft: session.draft };
  }

  private applyAnswer(session: DraftSession, id: string, text: string): void {
    const draft = session.draft;
    switch (id) {
      case 'name':
        draft.name = text;
        break;
      case 'description':
        draft.description = text;
        break;
      case 'rules':
        draft.rules = text
          .split(/[；;\n]/)
          .map((rule) => rule.trim())
          .filter(Boolean)
          .slice(0, 5);
        break;
      case 'resources':
        draft.resource_direction = text;
        break;
      case 'monsters':
        draft.monsters = [
          {
            name: text,
            max_level: draft.monsters?.[0]?.max_level ?? 1,
            count: draft.monsters?.[0]?.count ?? 3,
            concentrated: draft.monsters?.[0]?.concentrated ?? false,
            point_name: draft.monsters?.[0]?.point_name,
          },
        ];
        break;
      case 'max_level': {
        const level = Math.max(0, Math.min(7, Number.parseInt(text, 10) || 0));
        this.ensureMonster(draft).max_level = level;
        break;
      }
      case 'count': {
        const count = Math.max(1, Math.min(12, Number.parseInt(text, 10) || 1));
        this.ensureMonster(draft).count = count;
        break;
      }
      case 'concentrated': {
        const concentrated = /集中/.test(text);
        this.ensureMonster(draft).concentrated = concentrated;
        break;
      }
      case 'point_name':
        if (text) this.ensureMonster(draft).point_name = text;
        break;
      case 'buildings':
        draft.buildings = text ? text.split(/[、,，\n]/).map((v) => v.trim()).filter(Boolean) : [];
        break;
      case 'defenses':
        draft.defenses = text ? text.split(/[、,，\n]/).map((v) => v.trim()).filter(Boolean) : [];
        break;
      case 'weapons':
        draft.weapons = text ? text.split(/[、,，\n]/).map((v) => v.trim()).filter(Boolean) : [];
        break;
      default:
        break;
    }
  }

  private ensureMonster(draft: Partial<IslandDraft>): NonNullable<IslandDraft['monsters']>[number] {
    if (!draft.monsters || draft.monsters.length === 0) {
      draft.monsters = [{ name: '溺尸', max_level: 1, count: 3, concentrated: false }];
    }
    return draft.monsters[0];
  }

  async summary(characterId: string): Promise<{ draft: Partial<IslandDraft>; issues: DraftIssue[] }> {
    const session = this.session(characterId);
    if (!session) throw new Error('没有正在进行的造岛流程');
    const draft = this.normalize(session.draft);
    const state = await this.world.getState();
    const check = validateDraft(draft, state.world_day);
    return { draft, issues: check.issues };
  }

  // ------------------------------------------------------------ 创建

  /** 对话流程确认创建 */
  async confirm(character: Character): Promise<CreateIslandResult> {
    const session = this.session(character.id);
    if (!session) throw new Error('没有正在进行的造岛流程');
    const draft = this.normalize(session.draft);
    const result = await this.create(character, draft);
    this.sessions.delete(character.id);
    return result;
  }

  /** 自由描述 / REST 直接创建 */
  async create(character: Character, raw: Partial<IslandDraft>): Promise<CreateIslandResult> {
    const draft = this.normalize(raw);
    const state = await this.world.getState();
    const warnings: string[] = [];

    // 1. 结构 + 强度校验
    const check = validateDraft(draft, state.world_day);
    if (!check.ok) {
      throw new Error(check.issues.map((issue) => issue.message).join('；'));
    }

    // 2. 数量配额（§3：可创建数量与等级挂钩）
    const quota = islandQuota(character.level);
    const owned = await this.islands.count({ where: { creator_user_id: character.user_id } });
    if (owned >= quota) throw new Error(`你当前等级最多拥有 ${quota} 座岛，已达上限`);

    // 3. 规则内容检查：红线 + 与全局规则冲突（§4.4、§4.2）
    for (const rule of draft.rules) {
      const red = this.filter.checkInput(rule);
      if (!red.ok) throw new Error('岛屿规则触发了内容红线，请修改后重新提交');
      if (FORBIDDEN_RULE_PATTERNS.some((pattern) => pattern.test(rule))) {
        throw new Error(`规则「${rule}」试图改写全局规则（如无敌 / 免疫 / 无限资源），不允许生效`);
      }
    }
    const desc = this.filter.checkInput(draft.description);
    if (!desc.ok) throw new Error('岛屿描述触发了内容红线，请修改后重新提交');

    // 4. 随机放置：出生区禁建 + 最小间距（§3、§4.1）
    const placed = await this.place(draft);
    if (!placed) throw new Error('当前海域没有满足间距要求的位置，稍后再试');

    // 5. 落库
    const island = await this.islands.save(
      this.islands.create({
        id: randomUUID(),
        creator_user_id: character.user_id,
        name: draft.name,
        x: placed.x,
        y: placed.y,
        radius: islandRadius(draft.monsters.reduce((sum, group) => sum + group.count, 0), draft.monsters[0]?.max_level ?? 0),
        rules: draft.rules,
        resource_direction: draft.resource_direction,
        buildings: draft.buildings,
        defenses: draft.defenses,
        monster_config: { monsters: draft.monsters, weapons: draft.weapons },
        threat_budget: threatBudget(state.world_day),
        threat_used: check.threat_used,
        max_monster_level: Math.max(...draft.monsters.map((group) => group.max_level)),
        visit_count: 0,
        resources_taken: 0,
        owner_character_id: null,
        created_world_day: state.world_day,
        last_visit_world_day: state.world_day,
        status: 'active',
        description: draft.description,
      }),
    );

    await this.channels.save(
      this.channels.create({ id: randomUUID(), type: 'island', island_id: island.id, name: island.name }),
    );

    await this.spawnMonsters(island, draft, state.world_day);
    await this.spawnResources(island, draft);

    if (draft.monsters.some((group) => group.concentrated && group.point_name)) {
      const point = draft.monsters.find((group) => group.concentrated && group.point_name)!;
      await this.points.save(
        this.points.create({
          id: randomUUID(),
          island_id: island.id,
          name: point.point_name ?? '集中点',
          description: `${island.name}的怪物集中点`,
          monster_kind_ids: [],
          monster_count: point.count,
        }),
      );
    }

    await this.characters.recordExperience(
      character.id,
      state.world_day,
      state.world_minutes,
      'island_create',
      `创建了岛屿「${island.name}」`,
    );

    const summary =
      `岛屿「${island.name}」已经落成：影响半径 ${round1(island.radius)} 海里，` +
      `威胁度 ${check.threat_used}/${island.threat_budget}，${draft.monsters.reduce((sum, g) => sum + g.count, 0)} 只怪物。` +
      `坐标由洋流随机决定，连你自己也看不到——去海上找它吧。`;

    this.logger.log(`造岛成功：${island.name} by ${character.name}`);
    return { island, summary, warnings };
  }

  private normalize(raw: Partial<IslandDraft>): IslandDraft {
    const monsters = (raw.monsters && raw.monsters.length > 0 ? raw.monsters : [{ name: '溺尸', max_level: 1, count: 3, concentrated: false }]).map(
      (group) => ({
        ...group,
        max_level: Math.max(0, Math.min(7, Math.floor(group.max_level ?? 1))),
        count: Math.max(1, Math.min(12, Math.floor(group.count ?? 1))),
        concentrated: Boolean(group.concentrated),
      }),
    );
    return {
      name: (raw.name ?? '').trim(),
      description: (raw.description ?? '').trim(),
      rules: (raw.rules ?? []).map((rule) => rule.trim()).filter(Boolean).slice(0, 5),
      resource_direction: (raw.resource_direction ?? '').trim(),
      resource_count: Math.max(3, Math.min(30, Math.floor(raw.resource_count ?? 8))),
      monsters,
      buildings: (raw.buildings ?? []).filter(Boolean).slice(0, 8),
      defenses: (raw.defenses ?? []).filter(Boolean).slice(0, 6),
      weapons: (raw.weapons ?? []).filter(Boolean).slice(0, 6),
    };
  }

  /** 在有限海域内随机取点：远离出生区与已有岛（创建者不可见坐标，§3） */
  private async place(draft: IslandDraft): Promise<{ x: number; y: number } | null> {
    const state = await this.world.getState();
    const existing = await this.islands.find();
    const radius = islandRadius(draft.monsters.reduce((sum, group) => sum + group.count, 0), draft.monsters[0]?.max_level ?? 0);
    const seaRadius = Math.max(30, state.sea_radius_nm);

    for (let attempt = 0; attempt < 400; attempt += 1) {
      const angle = Math.random() * Math.PI * 2;
      const distance = Math.sqrt(Math.random()) * Math.max(1, seaRadius - radius - 2);
      const x = Math.cos(angle) * distance;
      const y = Math.sin(angle) * distance;
      if (distance < GAME.SPAWN_NO_BUILD_RADIUS_NM) continue;
      const tooClose = existing.some(
        (island) => distanceNm(x, y, island.x, island.y) < GAME.MIN_ISLAND_DISTANCE_NM,
      );
      if (tooClose) continue;
      return { x: Number(x.toFixed(3)), y: Number(y.toFixed(3)) };
    }
    return null;
  }

  private async spawnMonsters(island: Island, draft: IslandDraft, worldDay: number): Promise<void> {
    const kinds = await this.kinds.find();
    for (const group of draft.monsters) {
      const kind =
        kinds.find((item) => group.name && item.name === group.name.replace(/[（(].*$/, '').trim()) ??
        kinds.find((item) => group.name && item.name.includes(group.name.replace(/[（(].*$/, '').trim())) ??
        kinds.find((item) => item.name === '溺尸') ??
        kinds[0];
      for (let i = 0; i < group.count; i += 1) {
        const level = Math.max(0, Math.min(group.max_level, Math.floor(Math.random() * (group.max_level + 1))));
        const base = kind ?? { base_hp: 10, base_speed: 5, base_attack: 3 };
        await this.monsters.save(
          this.monsters.create({
            id: randomUUID(),
            kind_id: kind?.id ?? null,
            custom_name: kind ? null : group.name ?? '岛上的东西',
            custom_stats: kind ? null : { checked: true },
            island_id: island.id,
            level,
            hp: Math.round(base.base_hp * (1 + level * 0.6)),
            max_hp: Math.round(base.base_hp * (1 + level * 0.6)),
            speed: base.base_speed + level,
            attack: base.base_attack + level * 2,
            x: 0,
            y: 0,
            state: 'idle',
            faction_id: null,
            skills: [],
            created_world_day: worldDay,
          }),
        );
      }
    }
  }

  private async spawnResources(island: Island, draft: IslandDraft): Promise<void> {
    const categories = await this.resources.categoriesOf(draft.resource_direction);
    const total = draft.resource_count;
    for (const [index, category] of categories.entries()) {
      const quantity = Math.max(2, Math.round(total / Math.max(1, categories.length)) + (index === 0 ? 2 : 0));
      await this.items.save(
        this.items.create({
          id: randomUUID(),
          name: RESOURCE_LABEL[category] ?? '杂物',
          type: category,
          tags: [draft.resource_direction.slice(0, 40)],
          quantity,
          condition: null,
          owner_type: 'island',
          owner_id: island.id,
          x: island.x,
          y: island.y,
        }),
      );
    }
  }

  async quotaInfo(character: Character): Promise<{ used: number; quota: number }> {
    return {
      used: await this.islands.count({ where: { creator_user_id: character.user_id } }),
      quota: islandQuota(character.level),
    };
  }

  /** 面向创建者的统计：不含坐标（§3 防自肥） */
  async panel(islandId: string, viewer: Character) {
    const island = await this.islands.findOne({ where: { id: islandId } });
    if (!island) return null;
    const isCreator = island.creator_user_id === viewer.user_id;
    const isOwner = island.owner_character_id === viewer.id;
    if (!isCreator && !isOwner) return null;

    const monsters = await this.monsters.find({ where: { island_id: islandId } });
    const alive = monsters.filter((monster) => monster.state !== 'dead');
    const rawBuildings = island.buildings as any;
    const base = (Array.isArray(rawBuildings) ? null : rawBuildings?.base) ?? null;
    const defenses = Array.isArray(island.defenses) ? island.defenses : [];
    return {
      island_id: island.id,
      name: island.name,
      created_world_day: island.created_world_day,
      visit_count: island.visit_count,
      resources_taken: island.resources_taken,
      last_visit_world_day: island.last_visit_world_day,
      max_monster_level: island.max_monster_level,
      monster_count: alive.length,
      defense_power: defenses.length * 2 + (base?.defense_lv ?? 0) * 5,
      firepower: alive.reduce((sum, monster) => sum + monster.attack, 0),
      team_size: 0,
      base,
      // 注意：不返回 x / y，创建者永远看不到自己岛的坐标
    };
  }
}
