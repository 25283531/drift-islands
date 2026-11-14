import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { Character, ExperienceLog, Skill } from '../database/entities/character.entities';
import { DeadDrop, Item } from '../database/entities/item.entities';
import { AiGatewayService } from '../ai/ai-gateway.service';
import { CharactersService } from '../characters/characters.service';
import { WorldService } from '../world/world.service';
import {
  DAILY_ONLINE_SECONDS,
  encounterAllowed,
  fatigueAfterOnline,
  fatigueAfterRecovery,
  learnableSkills,
  maxSelectableProtectionLevel,
  pickSkillByExperience,
  protectionActive,
  suddenDeathChance,
  SkillDef,
} from '../game/m3';

/** 资质 → 最近经历关键词（用于规则兜底） */
const TAG_HINTS: Record<string, string[]> = {
  近身: ['melee', 'attack'],
  战斗: ['attack', 'defense'],
  受伤: ['defense', 'survival', 'heal'],
  夜: ['vision', 'light', 'dark'],
  海: ['water', 'wind', 'sail'],
  风: ['wind', 'sail'],
  火: ['fire'],
  雷: ['lightning'],
  恐惧: ['fear', 'control'],
  交易: ['support'],
  航行: ['sail', 'wind'],
};

/** 技能领悟（§4.2） */
@Injectable()
export class SkillsService {
  private readonly logger = new Logger(SkillsService.name);

  constructor(
    @InjectRepository(Skill) private readonly skills: Repository<Skill>,
    @InjectRepository(Character) private readonly characters: Repository<Character>,
    @InjectRepository(ExperienceLog) private readonly logs: Repository<ExperienceLog>,
    private readonly charactersService: CharactersService,
    private readonly world: WorldService,
    private readonly ai: AiGatewayService,
  ) {}

  @OnEvent('character.levelup')
  async onLevelUp(payload: { character_id: string; level: number }): Promise<void> {
    try {
      await this.learnIfDue(payload.character_id, payload.level);
    } catch (error) {
      this.logger.warn(`技能领悟失败：${(error as Error).message}`);
    }
  }

  async learnIfDue(characterId: string, level?: number) {
    const character = await this.charactersService.get(characterId);
    if (!character) throw new Error('角色不存在');
    const targetLevel = level ?? character.level;
    const learned = await this.skills.find({ where: { character_id: character.id } });
    const learnedNames = learned.map((skill) => skill.name);
    const candidates = learnableSkills(character.aptitude, targetLevel, learnedNames);
    if (candidates.length === 0) return { learned: null, candidates: [] };

    const state = await this.world.getState();
    const recent = await this.logs.find({
      where: { character_id: character.id },
      order: { created_at: 'DESC' },
      take: 20,
    });
    const recentText = recent
      .filter((log) => log.world_day >= state.world_day - 2)
      .map((log) => `${log.event_type}:${log.summary}`)
      .join('；');

    let chosen = this.rulePick(candidates, recentText, character.aptitude);
    const aiPick = await this.aiPick(character, candidates, recentText);
    if (aiPick) chosen = aiPick;

    const skill = await this.skills.save(
      this.skills.create({
        id: randomUUID(),
        character_id: character.id,
        direction: character.aptitude,
        name: chosen.name,
        level_unlocked: targetLevel,
        acquired_world_day: state.world_day,
        source_summary: recentText.slice(0, 300) || '凭直觉摸到了边',
        payload: { tags: chosen.tags, description: chosen.description, picked_by: aiPick ? 'ai' : 'rule' },
      }),
    );
    await this.charactersService.recordExperience(character.id, state.world_day, state.world_minutes, 'skill', `领悟技能「${chosen.name}」`);
    return { learned: { id: skill.id, name: chosen.name, description: chosen.description }, candidates: candidates.map((c) => c.name) };
  }

  async list(characterId: string) {
    const character = await this.charactersService.get(characterId);
    if (!character) throw new Error('角色不存在');
    const rows = await this.skills.find({ where: { character_id: character.id }, order: { level_unlocked: 'ASC' } });
    const all = learnableSkills(character.aptitude, character.level, rows.map((row) => row.name));
    return {
      aptitude: character.aptitude,
      level: character.level,
      skills: rows.map((row) => ({
        name: row.name,
        level_unlocked: row.level_unlocked,
        acquired_world_day: row.acquired_world_day,
        description: (row.payload ?? {}).description ?? '',
        picked_by: (row.payload ?? {}).picked_by ?? 'rule',
      })),
      next: all.map((skill) => skill.name),
    };
  }

  private rulePick(candidates: SkillDef[], recentText: string, aptitude: string): SkillDef {
    const tags = new Set<string>();
    for (const [keyword, mapped] of Object.entries(TAG_HINTS)) {
      if (recentText.includes(keyword)) mapped.forEach((tag) => tags.add(tag));
    }
    for (const tag of TAG_HINTS[aptitude] ?? []) tags.add(tag);
    return pickSkillByExperience(candidates, [...tags]) ?? candidates[0];
  }

  private async aiPick(character: Character, candidates: SkillDef[], recentText: string): Promise<SkillDef | null> {
    if (candidates.length <= 1 || !recentText) return null;
    const listText = candidates.map((skill) => `${skill.name}（${skill.description}）`).join('；');
    const prompt = [
      `角色资质：${character.aptitude}，等级 ${character.level}。`,
      `最近两天的经历：${recentText.slice(0, 500)}`,
      `候选技能：${listText}`,
      '只输出一个技能名称，不要解释。',
    ].join('\n');
    try {
      const reply = await this.ai.call('skill_pick', prompt, { tier: 'small', maxTokens: 20 });
      const hit = candidates.find((skill) => reply.includes(skill.name));
      return hit ?? null;
    } catch {
      return null;
    }
  }
}

/** 疲劳与猝死（§3） */
@Injectable()
export class FatigueService {
  private readonly logger = new Logger(FatigueService.name);
  private dayOf = new Map<string, number>();
  private recentOnline = new Map<string, number>();

  constructor(
    @InjectRepository(Character) private readonly characters: Repository<Character>,
    @InjectRepository(Item) private readonly items: Repository<Item>,
    @InjectRepository(DeadDrop) private readonly drops: Repository<DeadDrop>,
    private readonly charactersService: CharactersService,
    private readonly world: WorldService,
  ) {}

  /** 心跳/行动时累计在线时长；跨日重置并结算疲劳日 */
  async touch(characterId: string, onlineSeconds = 30): Promise<{ fatigue: number; warning?: string }> {
    const character = await this.charactersService.get(characterId);
    if (!character) throw new Error('角色不存在');
    const time = await this.world.timeInfo();
    const trackedDay = this.dayOf.get(character.id);
    if (trackedDay !== undefined && trackedDay !== time.world_day) {
      character.online_seconds_today = 0;
      character.fatigued_world_days = character.fatigue >= 60 ? character.fatigued_world_days + 1 : 0;
      if (character.fatigued_world_days === 0) character.fatigue = Math.max(0, character.fatigue - 25);
      await this.characters.save(character);
    }
    this.dayOf.set(character.id, time.world_day);

    const last = this.recentOnline.get(character.id);
    const gapSeconds = last === undefined ? onlineSeconds : Math.min(600, Math.max(0, Math.round((Date.now() - last) / 1000)));
    this.recentOnline.set(character.id, Date.now());
    const addSeconds = last === undefined ? onlineSeconds : gapSeconds > 90 ? onlineSeconds : Math.min(gapSeconds, onlineSeconds);
    if (addSeconds > 0) {
      character.online_seconds_today += addSeconds;
      character.fatigue = Math.round(fatigueAfterOnline(character.fatigue, character.online_seconds_today));
      character.last_seen_at = new Date();
      await this.characters.save(character);
    }

    if (character.online_seconds_today > DAILY_ONLINE_SECONDS) {
      character.fatigued_world_days = Math.max(1, character.fatigued_world_days);
    }

    const deathChance = suddenDeathChance(character.fatigued_world_days);
    if (deathChance > 0 && Math.random() < deathChance / 100) {
      const died = await this.suddenDeath(character.id);
      return { fatigue: character.fatigue, warning: died };
    }

    const warning =
      character.online_seconds_today > DAILY_ONLINE_SECONDS
        ? `你已经在海上待了 ${Math.round(character.online_seconds_today / 3600)} 小时，眼睛开始发涩。（疲劳 ${character.fatigue}）`
        : undefined;
    return { fatigue: character.fatigue, warning };
  }

  /** 离线恢复：每世界小时 25% */
  async recover(characterId: string, worldHoursOffline: number): Promise<{ fatigue: number }> {
    const character = await this.charactersService.get(characterId);
    if (!character) throw new Error('角色不存在');
    character.fatigue = Math.round(fatigueAfterRecovery(character.fatigue, worldHoursOffline));
    await this.characters.save(character);
    return { fatigue: character.fatigue };
  }

  private async suddenDeath(characterId: string): Promise<string> {
    const character = await this.charactersService.get(characterId);
    if (!character) return '';
    const items = await this.items.find({ where: { owner_type: 'character', owner_id: character.id } });
    if (items.length > 0) {
      const state = await this.world.getState();
      const drop = await this.drops.save(
        this.drops.create({
          id: randomUUID(),
          placer_character_id: character.id,
          x: character.x,
          y: character.y,
          item_ids: items.map((item) => item.id),
          created_world_day: state.world_day,
          discovered_by: null,
        }),
      );
      for (const item of items) {
        item.owner_type = 'ground';
        item.owner_id = drop.id;
        item.x = character.x;
        item.y = character.y;
        await this.items.save(item);
      }
    }
    character.hp = 0;
    character.status = 'dead';
    character.fatigue = 0;
    character.fatigued_world_days = 0;
    character.online_seconds_today = 0;
    await this.characters.save(character);
    this.logger.warn(`角色 ${character.name} 因连续疲劳猝死`);
    return '你连续几天没有真正睡过。最后一次眨眼时，甲板在眼前翻了过来——你倒下了，随身的东西散在脚边。';
  }
}

/** 新玩家保护期（§3、§4.1） */
@Injectable()
export class ProtectionService {
  constructor(
    @InjectRepository(Character) private readonly characters: Repository<Character>,
    private readonly charactersService: CharactersService,
  ) {}

  async options(): Promise<{ levels: { level: number; count: number }[]; max_selectable: number }> {
    const rows = await this.characters
      .createQueryBuilder('c')
      .select('c.level', 'level')
      .addSelect('COUNT(*)', 'count')
      .groupBy('c.level')
      .getRawMany<{ level: string; count: string }>();
    const counts: Record<number, number> = {};
    for (const row of rows) counts[Number(row.level)] = Number(row.count);
    const max = maxSelectableProtectionLevel(counts);
    return {
      levels: Object.entries(counts).map(([level, count]) => ({ level: Number(level), count })),
      max_selectable: max,
    };
  }

  async setProtection(characterId: string, level: number): Promise<{ protection_level: number; protection_active: boolean }> {
    const character = await this.charactersService.get(characterId);
    if (!character) throw new Error('角色不存在');
    const { max_selectable } = await this.options();
    const safe = Math.max(0, Math.min(Math.floor(level), max_selectable, 10));
    character.protection_level = safe;
    character.protection_active = protectionActive(character.level, safe);
    await this.characters.save(character);
    return { protection_level: safe, protection_active: character.protection_active };
  }

  /** 升级或登录时结算：达到保护等级即失效 */
  async settle(characterId: string): Promise<{ protection_level: number; protection_active: boolean; ended: boolean }> {
    const character = await this.charactersService.get(characterId);
    if (!character) throw new Error('角色不存在');
    if (!character.protection_active) {
      return { protection_level: character.protection_level, protection_active: false, ended: false };
    }
    if (character.level >= character.protection_level) {
      character.protection_active = false;
      await this.characters.save(character);
      return { protection_level: character.protection_level, protection_active: false, ended: true };
    }
    return { protection_level: character.protection_level, protection_active: true, ended: false };
  }

  allowsEncounter(character: Character, targetLevel: number): boolean {
    return encounterAllowed(character.level, character.protection_active ? character.protection_level : 0, targetLevel);
  }
}
