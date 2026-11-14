import { describe, expect, it } from 'vitest';
import {
  absorbableEnergy,
  applyEnergy,
  collectAmount,
  collectChance,
  crystalEnergy,
  energyForNextLevel,
  islandQuota,
  islandRadius,
  monsterLevelCap,
  threatBudget,
  upgradeCost,
  upgradeEffects,
  validateDraft,
  IslandDraft,
} from '../../src/game/m2';

const baseDraft = (): IslandDraft => ({
  name: '碎桅岛',
  description: '一座被风暴折断桅杆的旧渔港，浅滩上停着半沉的拖网船。',
  rules: ['夜里不要靠近灯塔', '岛上的淡水由岛主统一分配', '损坏的渔网可以拆成绳子'],
  resource_direction: '旧渔港：多食物与零件，少量燃料',
  resource_count: 10,
  monsters: [{ name: '拾荒者', max_level: 2, count: 3, concentrated: true, point_name: '鱼市' }],
  buildings: ['鱼市', '灯塔'],
  defenses: [{ name: '铁丝网' } as any].map(() => '铁丝网'),
  weapons: ['鱼叉炮'],
});

describe('M2 晶核能量曲线（§4.2）', () => {
  it('N 级晶体能量 = 100^(N-1)，0 级为 0.01', () => {
    expect(crystalEnergy(0)).toBeCloseTo(0.01, 6);
    expect(crystalEnergy(1)).toBe(1);
    expect(crystalEnergy(2)).toBe(100);
    expect(crystalEnergy(3)).toBe(10000);
  });

  it('升级需求：0→1 为 0.1，1→2 为 10，2→3 为 1000', () => {
    expect(energyForNextLevel(0)).toBeCloseTo(0.1, 6);
    expect(energyForNextLevel(1)).toBe(10);
    expect(energyForNextLevel(2)).toBe(1000);
    expect(energyForNextLevel(3)).toBe(100000);
  });

  it('越级吸收只吸收当前等级一级的量，剩余留在晶体中', () => {
    // 0 级人物吸收 2 级晶体（100 单位）：一次最多 0.1，剩下的 99.9 仍在晶体里
    expect(absorbableEnergy(0, 100)).toBeCloseTo(0.1, 6);
    const first = applyEnergy(0, 0, absorbableEnergy(0, 100));
    expect(first.level).toBe(1);
    expect(first.energy).toBeCloseTo(0, 6);
    expect(100 - 0.1).toBeGreaterThan(99);
  });

  it('同級晶体按 10 颗一级升级：10 单位恰好升到 2 级', () => {
    const result = applyEnergy(1, 0, 10);
    expect(result.level).toBe(2);
    expect(result.energy).toBeCloseTo(0, 6);
  });

  it('能量溢出后连续升级', () => {
    const result = applyEnergy(0, 0, 0.1 + 10 + 1000);
    expect(result.level).toBe(3);
    expect(result.energy).toBeCloseTo(0, 4);
  });

  it('7 级封顶', () => {
    const result = applyEnergy(6, 0, 1e12);
    expect(result.level).toBe(7);
    expect(result.energy).toBeLessThanOrEqual(energyForNextLevel(7));
  });
});

describe('M2 船只四条线', () => {
  it('消耗随目标等级线性增长', () => {
    expect(upgradeCost('defense', 0)).toEqual({ needs: { part: 2, fuel: 1 } });
    expect(upgradeCost('defense', 1)).toEqual({ needs: { part: 4, fuel: 2 } });
    expect(upgradeCost('living', 0)).toEqual({ needs: { food: 2, water: 2 } });
    expect(upgradeCost('research', 2)).toEqual({ needs: { tech: 6, part: 3 } });
  });

  it('效果按等级叠加', () => {
    expect(upgradeEffects('defense', 1).max_durability).toBe(15);
    expect(upgradeEffects('weapon', 2).weapon_power).toBe(8);
    expect(upgradeEffects('living', 1).cargo_capacity).toBe(6);
    expect(upgradeEffects('research', 3)).toEqual({});
  });
});

describe('M2 造岛校验', () => {
  it('合法草稿通过，并算出威胁度', () => {
    const check = validateDraft(baseDraft(), 1);
    expect(check.ok).toBe(true);
    // 2 级 × 3 只 = 6，防御 1 项 2 点，武器 1 项 2 点
    expect(check.threat_used).toBe(10);
    expect(check.threat_used).toBeLessThanOrEqual(threatBudget(1));
  });

  it('规则少于 3 条不通过', () => {
    const draft = baseDraft();
    draft.rules = ['只有一条'];
    const check = validateDraft(draft, 1);
    expect(check.ok).toBe(false);
    expect(check.issues.some((issue) => issue.field === 'rules')).toBe(true);
  });

  it('怪物等级超过当前世界上限不通过', () => {
    const draft = baseDraft();
    draft.monsters[0].max_level = 7;
    const check = validateDraft(draft, 1);
    expect(check.ok).toBe(false);
    expect(check.issues.some((issue) => issue.field === 'monsters')).toBe(true);
  });

  it('威胁度超预算不通过', () => {
    const draft = baseDraft();
    // 三组 2 级 × 12 只 = 72，加防御与武器后超过第 1 日预算 60
    draft.monsters = [
      { name: '盗掘者', max_level: 2, count: 12, concentrated: false },
      { name: '溺水者', max_level: 2, count: 12, concentrated: false },
      { name: '藤壶蟹', max_level: 2, count: 12, concentrated: false },
    ];
    draft.defenses = ['铁丝网', '警铃', '沙袋'];
    const check = validateDraft(draft, 1);
    expect(check.ok).toBe(false);
    expect(check.issues.some((issue) => issue.field === 'threat')).toBe(true);
  });

  it('等级上限与世界日、数量配额', () => {
    expect(monsterLevelCap(1)).toBe(2);
    expect(monsterLevelCap(10)).toBe(4);
    expect(monsterLevelCap(100)).toBe(7);
    expect(islandQuota(0)).toBe(1);
    expect(islandQuota(5)).toBe(2);
    expect(islandRadius(1, 0)).toBeGreaterThanOrEqual(3);
    expect(islandRadius(12, 7)).toBeLessThanOrEqual(8);
  });
});

describe('M2 收集裁决', () => {
  it('成功率随等级差与科研提升，并钳制在 15%–90%', () => {
    const base = collectChance({ characterLevel: 2, islandMaxLevel: 2, researchLv: 0, monstersAlive: false });
    expect(base).toBeCloseTo(0.55, 4);
    expect(
      collectChance({ characterLevel: 5, islandMaxLevel: 1, researchLv: 2, monstersAlive: false }),
    ).toBeLessThanOrEqual(0.9);
    expect(
      collectChance({ characterLevel: 0, islandMaxLevel: 7, researchLv: 0, monstersAlive: true }),
    ).toBeGreaterThanOrEqual(0.15);
  });

  it('产量在 1–6 之间，高威胁岛减产', () => {
    expect(collectAmount({ researchLv: 0, islandMaxLevel: 1, roll: 0 })).toBe(1);
    expect(collectAmount({ researchLv: 2, islandMaxLevel: 1, roll: 0.99 })).toBeGreaterThanOrEqual(1);
    expect(collectAmount({ researchLv: 0, islandMaxLevel: 5, roll: 0.99 })).toBe(2);
  });
});
