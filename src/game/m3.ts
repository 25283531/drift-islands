/**
 * M3 规则与数值（可单测的纯函数）。
 * 设计说明 v1.4 §3、§4.1、§4.2；数值为 M3 先行值，集中在这里便于调校。
 */

// ---------------------------------------------------------------- 疲劳与猝死（§3）

/** 每日在线时长上限：8 现实小时 */
export const DAILY_ONLINE_SECONDS = 8 * 3600;
/** 超出部分每小时增加的疲劳值（0–100） */
export const FATIGUE_PER_EXTRA_HOUR = 10;
/** 非疲劳世界日恢复速度：每世界时 25% */
export const FATIGUE_RECOVERY_PER_WORLD_HOUR = 25;

/** 计算在线后的疲劳值（钳制 0–100） */
export function fatigueAfterOnline(current: number, onlineSecondsToday: number): number {
  const extraSeconds = Math.max(0, onlineSecondsToday - DAILY_ONLINE_SECONDS);
  const extraHours = extraSeconds / 3600;
  return Math.max(0, Math.min(100, current + extraHours * FATIGUE_PER_EXTRA_HOUR));
}

/**
 * 猝死概率：连续疲劳第 3 日 30%，第 4 日 55%，第 5 日 80%，第 6 日 100%。
 * 公式 30% + (连续疲劳世界日 - 3) × 25%，封顶 100%。
 */
export function suddenDeathChance(consecutiveFatiguedDays: number): number {
  if (consecutiveFatiguedDays < 3) return 0;
  return Math.min(1, 0.3 + (consecutiveFatiguedDays - 3) * 0.25);
}

/** 离线恢复：每世界小时 25%，4 世界时回满 */
export function fatigueAfterRecovery(current: number, worldHoursOffline: number): number {
  return Math.max(0, current - worldHoursOffline * FATIGUE_RECOVERY_PER_WORLD_HOUR);
}

// ---------------------------------------------------------------- 保护期（§3、§4.1）

/** 保护期内不偶遇高于自身 2 级以上的怪物与玩家 */
export const PROTECTION_LEVEL_GAP = 2;

export function protectionActive(characterLevel: number, protectionLevel: number): boolean {
  return protectionLevel > 0 && characterLevel < protectionLevel;
}

/** 保护期内是否允许遭遇该等级目标 */
export function encounterAllowed(characterLevel: number, protectionLevel: number, targetLevel: number): boolean {
  if (!protectionActive(characterLevel, protectionLevel)) return true;
  return targetLevel <= characterLevel + PROTECTION_LEVEL_GAP;
}

/** 可选保护期等级：不得大于当前人数最多的等级（并列取较高） */
export function maxSelectableProtectionLevel(levelCounts: Record<number, number>): number {
  const entries = Object.entries(levelCounts).map(([level, count]) => [Number(level), count] as const);
  if (entries.length === 0) return 0;
  let bestLevel = 0;
  let bestCount = -1;
  for (const [level, count] of entries) {
    if (count > bestCount || (count === bestCount && level > bestLevel)) {
      bestLevel = level;
      bestCount = count;
    }
  }
  return bestLevel;
}

// ---------------------------------------------------------------- 夺岛（§4.2）

/** 摧毁防御后需连续占领 1 世界小时 */
export const CAPTURE_MINUTES = 60;

export function captureProgress(startedWorldDay: number, startedMinutes: number, nowDay: number, nowMinutes: number): number {
  const elapsed = (nowDay - startedWorldDay) * 1440 + (nowMinutes - startedMinutes);
  return Math.max(0, Math.min(CAPTURE_MINUTES, elapsed));
}

export function captureComplete(startedWorldDay: number, startedMinutes: number, nowDay: number, nowMinutes: number): boolean {
  return captureProgress(startedWorldDay, startedMinutes, nowDay, nowMinutes) >= CAPTURE_MINUTES;
}

// ---------------------------------------------------------------- 团队（§3）

/** 移动与物资消耗按船上实际人数计算 */
export function crewFuelMultiplier(crewCount: number): number {
  return Math.max(1, Math.min(8, Math.floor(crewCount)));
}

/** 交易地点规则：同岛可交易；两人都在海上也可交易；一岛一海不可 */
export function canTradeAt(
  a: { island_id?: string | null },
  b: { island_id?: string | null },
): boolean {
  if (a.island_id && b.island_id) return a.island_id === b.island_id;
  return !a.island_id && !b.island_id;
}

/** 团队称号：置于名字前 */
export function displayNameWithTeam(name: string, teamName: string | null, showTitle: boolean): string {
  if (!showTitle || !teamName) return name;
  return `【${teamName}】${name}`;
}

// ---------------------------------------------------------------- 技能池（§4.2）

export interface SkillDef {
  name: string;
  level: number;
  description: string;
  tags: string[];
}

/** 每个资质方向一个预置技能池；领悟等级固定 */
export const SKILL_POOLS: Record<string, SkillDef[]> = {
  body: [
    { name: '铁皮', level: 1, description: '皮肤硬化，受到的近身伤害降低。', tags: ['defense', 'melee'] },
    { name: '蛮力', level: 3, description: '短时间爆发力量，攻击力提升。', tags: ['attack', 'melee'] },
    { name: '再生', level: 5, description: '伤口缓慢愈合，每回合恢复少量生命。', tags: ['heal'] },
    { name: '不坏之躯', level: 7, description: '濒死时强行撑住，免疫一次致命伤害。', tags: ['defense', 'survival'] },
  ],
  magic: [
    { name: '火花', level: 1, description: '指尖迸出火星，点燃易燃物。', tags: ['fire', 'attack'] },
    { name: '水刃', level: 3, description: '引海水成刃，切割敌人。', tags: ['water', 'attack'] },
    { name: '护盾术', level: 5, description: '在身前凝出一层薄薄的力场。', tags: ['defense'] },
    { name: '元素回响', level: 7, description: '连续施法时威力递增。', tags: ['fire', 'water', 'attack'] },
  ],
  light: [
    { name: '微光', level: 1, description: '在黑暗中看清近处。', tags: ['vision'] },
    { name: '灼烧之光', level: 3, description: '强光灼伤惧怕日光的怪物。', tags: ['attack', 'light'] },
    { name: '净化', level: 5, description: '驱散身上的毒素与低语。', tags: ['heal', 'cleanse'] },
    { name: '灯塔', level: 7, description: '在最深的夜里为同伴指路。', tags: ['vision', 'support'] },
  ],
  dark: [
    { name: '屏息', level: 1, description: '压低呼吸，减少被发现的概率。', tags: ['stealth'] },
    { name: '影缚', level: 3, description: '拖住目标的影子，使其减速。', tags: ['control'] },
    { name: '噬能', level: 5, description: '从敌人身上抽取一点体力。', tags: ['drain'] },
    { name: '深渊凝视', level: 7, description: '让低等怪物短暂僵住。', tags: ['control', 'fear'] },
  ],
  element: [
    { name: '听风', level: 1, description: '从风里听出远处的动静。', tags: ['vision', 'wind'] },
    { name: '引雷', level: 3, description: '在金属附近聚起电荷。', tags: ['lightning', 'attack'] },
    { name: '土墙', level: 5, description: '掀起甲板上的碎铁与沙，形成掩体。', tags: ['defense'] },
    { name: '风暴眼', level: 7, description: '在身周制造一小片混乱的气流。', tags: ['wind', 'control'] },
  ],
  martial: [
    { name: '稳舵', level: 1, description: '风浪中站得更稳，不易被击倒。', tags: ['defense', 'sail'] },
    { name: '连斩', level: 3, description: '一回合内连续出手两次。', tags: ['attack', 'melee'] },
    { name: '卸力', level: 5, description: '借对方的力化解攻击。', tags: ['defense', 'counter'] },
    { name: '船长之怒', level: 7, description: '全船士气提升，攻击与防御同时上升。', tags: ['support', 'attack'] },
  ],
};

/** 按等级取可领悟技能；同一等级只领悟一个 */
export function learnableSkills(aptitude: string, level: number, learned: string[]): SkillDef[] {
  const pool = SKILL_POOLS[aptitude] ?? SKILL_POOLS.body;
  return pool.filter((skill) => skill.level === level && !learned.includes(skill.name));
}

/** 规则兜底选择：按最近经历标签命中数排序，同分取池中靠前 */
export function pickSkillByExperience(
  candidates: SkillDef[],
  recentTags: string[],
): SkillDef | null {
  if (candidates.length === 0) return null;
  let best = candidates[0];
  let bestScore = -1;
  for (const skill of candidates) {
    const score = skill.tags.filter((tag) => recentTags.includes(tag)).length;
    if (score > bestScore) {
      bestScore = score;
      best = skill;
    }
  }
  return best;
}

// ---------------------------------------------------------------- 怪物智慧（§4.2）

export type MonsterAction = 'attack' | 'flee' | 'focus' | 'talk' | 'trap' | 'trade';

/** 按怪物等级给出可用行为；7 级可谈判 / 交易 / 设陷阱 */
export function monsterActions(level: number, hpRatio: number): MonsterAction[] {
  const actions: MonsterAction[] = ['attack'];
  if (level >= 3 && hpRatio <= 0.3) actions.push('flee');
  if (level >= 4) actions.push('focus');
  if (level >= 5) actions.push('talk');
  if (level >= 7) actions.push('trap', 'trade');
  return actions;
}
