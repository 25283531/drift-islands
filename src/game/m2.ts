/**
 * M2 数值与规则（可单测的纯函数）。
 * 取舍：设计说明只给公式/区间，未定数值集中在这里，便于 M2 调校。
 */

// ---------------------------------------------------------------- 晶核

/** N 级晶体能量 = 100^(N-1)；0 级 = 0.01 单位（§4.2） */
export function crystalEnergy(level: number): number {
  const lv = Math.max(0, Math.min(7, Math.floor(level)));
  return lv === 0 ? 0.01 : Math.pow(100, lv - 1);
}

/** 升到下一级所需能量：0→1 为 0.1；L→L+1 为 10 × 100^(L-1)（§4.2） */
export function energyForNextLevel(level: number): number {
  const lv = Math.max(0, Math.floor(level));
  return lv === 0 ? 0.1 : 10 * Math.pow(100, lv - 1);
}

/**
 * 越级吸收：一次最多吸收「当前等级升一级所需能量」，
 * 高等级晶体剩余的 energy_remaining 留在晶核里以后继续吸收（§4.2）。
 */
export function absorbableEnergy(characterLevel: number, remaining: number): number {
  const cap = energyForNextLevel(characterLevel);
  return Math.max(0, Math.min(cap, remaining));
}

/** 把能量加入角色后连续升级，返回新等级与新余量 */
export function applyEnergy(level: number, currentEnergy: number, gain: number): { level: number; energy: number } {
  let lv = Math.max(0, Math.floor(level));
  let energy = currentEnergy + Math.max(0, gain);
  // 防御性上限：最多连升到 7 级
  while (lv < 7 && energy >= energyForNextLevel(lv) - 1e-9) {
    energy -= energyForNextLevel(lv);
    lv += 1;
  }
  if (lv >= 7) energy = Math.min(energy, energyForNextLevel(7));
  return { level: lv, energy: Math.max(0, Number(energy.toFixed(6))) };
}

// ---------------------------------------------------------------- 船只升级

export const SHIP_TRACKS = ['defense', 'weapon', 'living', 'research'] as const;
export type ShipTrack = (typeof SHIP_TRACKS)[number];

export const SHIP_TRACK_MAX_LEVEL = 5;

export interface UpgradeCost {
  /** item.type → 数量 */
  needs: Record<string, number>;
}

/** 四条线消耗：按目标等级线性增长（防御/武器吃零件与科技，生活吃食物与水） */
export function upgradeCost(track: ShipTrack, currentLevel: number): UpgradeCost {
  const next = Math.max(0, Math.floor(currentLevel)) + 1;
  switch (track) {
    case 'defense':
      return { needs: { part: 2 * next, fuel: next } };
    case 'weapon':
      return { needs: { part: 2 * next, tech: next } };
    case 'living':
      return { needs: { food: 2 * next, water: 2 * next } };
    case 'research':
      return { needs: { tech: 2 * next, part: next } };
    default:
      throw new Error('未知的升级线路');
  }
}

/** 升级后的属性变化 */
export function upgradeEffects(
  track: ShipTrack,
  level: number,
): { max_durability?: number; weapon_power?: number; cargo_capacity?: number; max_stamina?: number; speed?: number } {
  const lv = Math.max(1, Math.floor(level));
  switch (track) {
    case 'defense':
      return { max_durability: 15 * lv };
    case 'weapon':
      return { weapon_power: 4 * lv };
    case 'living':
      return { cargo_capacity: 6 * lv, max_stamina: 5 * lv };
    case 'research':
      // 科研不直接加战斗数值：提高收集成功率与产量（见 collection）
      return {};
    default:
      return {};
  }
}

// ---------------------------------------------------------------- 造岛

/** 当前世界日的怪物强度上限（设计说明：上限随世界时钟提升，M2 先行值） */
export function monsterLevelCap(worldDay: number): number {
  return Math.min(7, 2 + Math.floor(Math.max(0, worldDay) / 5));
}

/** 岛屿威胁预算：50 + 10 × 世界日（M0 §4 建议值） */
export function threatBudget(worldDay: number): number {
  return 50 + 10 * Math.max(0, worldDay);
}

/** 岛屿影响半径：3–8 海里，随规模增大 */
export function islandRadius(monsterCount: number, maxLevel: number): number {
  const raw = 3 + Math.min(3, Math.floor(monsterCount / 4)) + Math.min(2, Math.floor(maxLevel / 2));
  return Math.max(3, Math.min(8, raw));
}

/** 单个创建者可拥有的岛屿数量：1 + floor(等级 / 5)（M0 §4 建议值） */
export function islandQuota(level: number): number {
  return 1 + Math.floor(Math.max(0, level) / 5);
}

export interface IslandDraft {
  name: string;
  description: string;
  rules: string[];
  resource_direction: string;
  resource_count: number;
  monsters: { kind_id?: string; name?: string; max_level: number; count: number; concentrated: boolean; point_name?: string }[];
  buildings: string[];
  defenses: string[];
  weapons: string[];
}

export interface DraftIssue {
  field: string;
  message: string;
}

/** 造岛结构校验（不含内容红线，红线由 ContentFilter 单独检查） */
export function validateDraft(draft: IslandDraft, worldDay: number): { ok: boolean; issues: DraftIssue[]; threat_used: number } {
  const issues: DraftIssue[] = [];
  const name = (draft.name ?? '').trim();
  if (name.length < 2 || name.length > 16) issues.push({ field: 'name', message: '岛名需 2–16 个字符' });
  if (!draft.description || draft.description.trim().length < 6) {
    issues.push({ field: 'description', message: '需要一句岛屿描述（至少 6 个字符）' });
  }
  const rules = (draft.rules ?? []).map((r) => r.trim()).filter(Boolean);
  if (rules.length < 3 || rules.length > 5) issues.push({ field: 'rules', message: '岛屿规则需 3–5 条' });
  if (rules.some((r) => r.length > 120)) issues.push({ field: 'rules', message: '单条规则不超过 120 字' });
  if (!draft.resource_direction || draft.resource_direction.trim().length < 2) {
    issues.push({ field: 'resource_direction', message: '需要描述资源方向，例如「废弃加油站，多燃料与零件」' });
  }

  const cap = monsterLevelCap(worldDay);
  let threat = 0;
  const monsters = draft.monsters ?? [];
  if (monsters.length === 0) issues.push({ field: 'monsters', message: '至少配置一种怪物' });
  for (const group of monsters) {
    if (group.max_level < 0 || group.max_level > 7) {
      issues.push({ field: 'monsters', message: '怪物等级需在 0–7 之间' });
      continue;
    }
    if (group.max_level > cap) {
      issues.push({ field: 'monsters', message: `当前世界第 ${worldDay} 日的怪物等级上限是 ${cap} 级` });
    }
    if (group.count < 1 || group.count > 12) {
      issues.push({ field: 'monsters', message: '单种怪物数量需 1–12' });
    }
    threat += group.max_level * group.count;
  }
  // 防御与武器也计入威胁：每项按 2 点计
  threat += (draft.defenses?.length ?? 0) * 2 + (draft.weapons?.length ?? 0) * 2;

  const budget = threatBudget(worldDay);
  if (threat > budget) {
    issues.push({ field: 'threat', message: `威胁度 ${threat} 超过预算 ${budget}（怪物等级 × 数量 + 防御/武器）` });
  }
  return { ok: issues.length === 0, issues, threat_used: threat };
}

// ---------------------------------------------------------------- 收集裁决

export interface CollectCheck {
  successChance: number;
  amount: number;
}

/**
 * 收集成功率：基础 55%，等级差 ±5%/级，科研每级 +4%，
 * 岛上有活怪 -10%，钳制在 15%–90%。判定只看数字（§4.2）。
 */
export function collectChance(params: {
  characterLevel: number;
  islandMaxLevel: number;
  researchLv: number;
  monstersAlive: boolean;
}): number {
  const raw =
    0.55 +
    (params.characterLevel - params.islandMaxLevel) * 0.05 +
    params.researchLv * 0.04 -
    (params.monstersAlive ? 0.1 : 0);
  return Math.max(0.15, Math.min(0.9, Number(raw.toFixed(4))));
}

/** 成功时的产量：1–3，科研每级 +1 上限；与威胁度成反比 */
export function collectAmount(params: { researchLv: number; islandMaxLevel: number; roll: number }): number {
  const max = 3 + Math.min(3, params.researchLv);
  const base = 1 + Math.floor(Math.max(0, Math.min(0.999, params.roll)) * max);
  const penalty = params.islandMaxLevel >= 4 ? 1 : 0;
  return Math.max(1, base - penalty);
}

// ---------------------------------------------------------------- 战斗参战上限

/**
 * 同时参战的怪物数量上限：0 级 1 只，每升 1 级 +1，最多 4 只。
 * 岛上的怪可以比这更多，但一次只惊动这么多，避免新手被围殴。
 */
export const CONCURRENT_MONSTERS = { base: 1, perLevel: 1, max: 4 } as const;

export function concurrentMonsterLimit(level: number): number {
  const lv = Math.max(0, Math.floor(level));
  return Math.max(
    CONCURRENT_MONSTERS.base,
    Math.min(CONCURRENT_MONSTERS.max, CONCURRENT_MONSTERS.base + lv * CONCURRENT_MONSTERS.perLevel),
  );
}
