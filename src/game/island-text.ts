import { IslandDraft } from './m2';

/** 造岛自由描述的结构化抽取（规则层，AI 只补空缺） */

const RESOURCE_HINTS: { type: string; words: string[] }[] = [
  { type: '燃料', words: ['燃料', '汽油', '柴油', '油罐', '加油站'] },
  { type: '食物', words: ['食物', '罐头', '干粮', '渔获', '食堂'] },
  { type: '淡水', words: ['淡水', '净水', '水井', '水库'] },
  { type: '药品', words: ['药品', '药', '医院', '诊所'] },
  { type: '零件', words: ['零件', '机械', '齿轮', '修船厂'] },
  { type: '武器', words: ['武器', '弹药', '军火', '枪'] },
  { type: '科技件', words: ['科技', '电子', '电台', '芯片'] },
];

const MONSTER_HINTS = ['溺尸', '拾荒者', '藤壶蟹', '海鬼', '铁皮狗', '盐尸'];
const BUILDING_HINTS = ['医院', '灯塔', '仓库', '码头', '教堂', '加油站', '渔村', '工厂', '哨塔', '学校', '电台'];
const DEFENSE_HINTS = ['围墙', '哨塔', '炮台', '岸防', '铁门', '栅栏'];
const WEAPON_HINTS = ['机枪', '岸炮', '鱼叉炮', '火焰喷射器', '弩炮'];

export interface MissingField {
  id: 'name' | 'description' | 'rules' | 'resources' | 'monsters' | 'max_level' | 'count';
  question: string;
}

export const MISSING_QUESTIONS: Record<MissingField['id'], string> = {
  name: '还差一个岛名。你想叫它什么？',
  description: '这座岛看起来是什么样子？一句话就行。',
  rules: '岛上有什么规矩？用「；」分隔，写 3–5 条。',
  resources: '岛上主要产出什么？例如「废弃加油站，多燃料与零件」。',
  monsters: '岛上的怪物叫什么？可以用：溺尸、拾荒者、藤壶蟹。',
  max_level: '怪物最高几级？（0–7）',
  count: '大概有几只怪物？（1–12）',
};

export interface ExtractedIsland {
  draft: Partial<IslandDraft>;
  missing: MissingField[];
  /** 命中的原始片段，便于回话时复述 */
  evidence: string[];
}

function sentences(text: string): string[] {
  return text
    .split(/[。；;\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function extractIslandDraft(raw: string): ExtractedIsland {
  const text = (raw ?? '').trim();
  const draft: Partial<IslandDraft> = {};
  const evidence: string[] = [];

  // 岛名
  const nameMatch =
    /(?:岛名|名字|叫做|名为|叫)\s*[:：]?\s*[「《"']?([^\s，。；、,.!?」》"']{2,16})/.exec(text) ??
    /[《「"']([^\s，。；、」》"']{2,16})[》」"']/.exec(text);
  if (nameMatch) {
    draft.name = nameMatch[1].trim();
    evidence.push(nameMatch[0]);
  }

  // 描述：取最长的一句（避免把规则当描述）
  const parts = sentences(text);
  const descCandidate = parts
    .filter((part) => !/规则|禁止|不许|不能|不要|必须|怪物|只|级/.test(part))
    .sort((a, b) => b.length - a.length)[0];
  if (descCandidate && descCandidate.length >= 6) {
    draft.description = descCandidate.slice(0, 120);
    evidence.push(descCandidate);
  }

  // 规则：优先取“规则：”后面的整段，按；拆分
  const ruleBlock = /规则\s*[:：]\s*([^。]+)/.exec(text)?.[1];
  const ruleParts = ruleBlock
    ? ruleBlock.split(/[；;\n]/).map((rule) => rule.trim()).filter(Boolean)
    : parts.filter((part) => /规则|禁止|不许|不能|不要|必须|否则|只要|天黑|夜里|不得/.test(part));
  if (ruleParts.length > 0) {
    draft.rules = ruleParts.slice(0, 5);
  }

  // 资源
  const foundResources = RESOURCE_HINTS.filter((hint) => hint.words.some((word) => text.includes(word)));
  if (foundResources.length > 0) {
    draft.resource_direction = foundResources.map((hint) => hint.type).join('、');
    evidence.push(draft.resource_direction);
  }

  // 怪物名
  const monsterName =
    MONSTER_HINTS.find((name) => text.includes(name)) ??
    /(?:有|盘踞着|游荡着)\s*[一二三四五六七八九十\d]*\s*(?:只|个)?\s*([^\s，。；、]{1,6}?)(?:怪物|尸|蟹|者)/.exec(text)?.[1];
  if (monsterName) evidence.push(monsterName);

  // 数量与等级
  const countMatch = /([0-9]+|[一二三四五六七八九十])\s*(?:只|个|名|具)/.exec(text);
  const levelMatch = /(?:等级|级)\s*[:：]?\s*([0-7])/.exec(text) ?? /([0-7])\s*级/.exec(text);

  if (monsterName) {
    draft.monsters = [
      {
        name: monsterName,
        max_level: levelMatch ? Number(levelMatch[1]) : 1,
        count: countMatch ? Number(countMatch[1]) || 1 : 3,
        concentrated: /集中|聚集|都在|守在/.test(text),
        point_name: /(?:集中|聚集|守)在?\s*[「《"']?([^\s，。；、」》"']{2,10})/.exec(text)?.[1],
      },
    ];
  }

  // 建筑 / 防御 / 武器
  const buildings = BUILDING_HINTS.filter((name) => text.includes(name));
  if (buildings.length > 0) draft.buildings = buildings;
  const defenses = DEFENSE_HINTS.filter((name) => text.includes(name));
  if (defenses.length > 0) draft.defenses = defenses;
  const weapons = WEAPON_HINTS.filter((name) => text.includes(name));
  if (weapons.length > 0) draft.weapons = weapons;

  // 缺失项
  const missing: MissingField[] = [];
  if (!draft.name) missing.push({ id: 'name', question: MISSING_QUESTIONS.name });
  if (!draft.description) missing.push({ id: 'description', question: MISSING_QUESTIONS.description });
  if (!draft.rules || draft.rules.length < 3) missing.push({ id: 'rules', question: MISSING_QUESTIONS.rules });
  if (!draft.resource_direction) missing.push({ id: 'resources', question: MISSING_QUESTIONS.resources });
  if (!draft.monsters?.[0]?.name) missing.push({ id: 'monsters', question: MISSING_QUESTIONS.monsters });
  if (!levelMatch) missing.push({ id: 'max_level', question: MISSING_QUESTIONS.max_level });
  if (!countMatch) missing.push({ id: 'count', question: MISSING_QUESTIONS.count });

  return { draft, missing, evidence };
}

/** 根据已有草稿重新计算缺口（AI 补充后使用） */
export function missingOf(draft: Partial<IslandDraft>): MissingField[] {
  const missing: MissingField[] = [];
  if (!draft.name) missing.push({ id: 'name', question: MISSING_QUESTIONS.name });
  if (!draft.description) missing.push({ id: 'description', question: MISSING_QUESTIONS.description });
  if (!draft.rules || draft.rules.length < 3) missing.push({ id: 'rules', question: MISSING_QUESTIONS.rules });
  if (!draft.resource_direction) missing.push({ id: 'resources', question: MISSING_QUESTIONS.resources });
  if (!draft.monsters?.[0]?.name) missing.push({ id: 'monsters', question: MISSING_QUESTIONS.monsters });
  return missing;
}

/** 把用户对某个缺失项的回答写进草稿 */
export function applyMissingAnswer(draft: Partial<IslandDraft>, field: MissingField['id'], raw: string): void {
  const text = (raw ?? '').trim();
  if (!text) return;
  switch (field) {
    case 'name':
      draft.name = text.slice(0, 16);
      break;
    case 'description':
      draft.description = text.slice(0, 120);
      break;
    case 'rules':
      draft.rules = text
        .split(/[；;\n]/)
        .map((rule) => rule.trim())
        .filter(Boolean)
        .slice(0, 5);
      break;
    case 'resources':
      draft.resource_direction = text.slice(0, 60);
      break;
    case 'monsters':
      draft.monsters = [
        {
          name: text.slice(0, 12),
          max_level: draft.monsters?.[0]?.max_level ?? 1,
          count: draft.monsters?.[0]?.count ?? 3,
          concentrated: draft.monsters?.[0]?.concentrated ?? false,
        },
      ];
      break;
    case 'max_level': {
      const level = Math.max(0, Math.min(7, Number.parseInt(text, 10) || 0));
      if (!draft.monsters?.length) {
        draft.monsters = [{ name: '溺尸', max_level: level, count: 3, concentrated: false }];
      } else {
        draft.monsters[0].max_level = level;
      }
      break;
    }
    case 'count': {
      const count = Math.max(1, Math.min(12, Number.parseInt(text, 10) || 1));
      if (!draft.monsters?.length) {
        draft.monsters = [{ name: '溺尸', max_level: 1, count, concentrated: false }];
      } else {
        draft.monsters[0].count = count;
      }
      break;
    }
  }
}

/** 回话：把抽取到的内容复述一遍，缺口逐条追问 */
export function describeExtraction(extracted: ExtractedIsland): string {
  const lines: string[] = [];
  const { draft } = extracted;
  if (draft.name) lines.push(`岛名：${draft.name}`);
  if (draft.description) lines.push(`样子：${draft.description}`);
  if (draft.rules?.length) lines.push(`规则：${draft.rules.join('；')}`);
  if (draft.resource_direction) lines.push(`资源：${draft.resource_direction}`);
  if (draft.monsters?.[0]) {
    lines.push(`怪物：${draft.monsters[0].name} ×${draft.monsters[0].count}，最高 ${draft.monsters[0].max_level} 级`);
  }
  if (lines.length === 0) return '我没从这段话里认出岛的样子。';
  return `我记下了这些：\n${lines.join('\n')}`;
}
