import { describe, expect, it } from 'vitest';
import {
  attackDamage,
  monsterFleeChance,
  playerAttackPower,
  playerDefense,
  playerFleeChance,
} from '../../src/combat/combat.rules';

describe('战斗数值规则（§4.2）', () => {
  it('玩家逃跑：基础 50%，速度差 ±5%，封顶 90% / 最低 10%', () => {
    expect(playerFleeChance(10, 10)).toBeCloseTo(0.5);
    expect(playerFleeChance(14, 10)).toBeCloseTo(0.7);
    expect(playerFleeChance(30, 10)).toBeCloseTo(0.9);
    expect(playerFleeChance(1, 20)).toBeCloseTo(0.1);
  });

  it('怪物低血逃跑概率：1–3 级 50%，4–6 级 20%，7 级不逃跑', () => {
    expect(monsterFleeChance(1)).toBeCloseTo(0.5);
    expect(monsterFleeChance(3)).toBeCloseTo(0.5);
    expect(monsterFleeChance(4)).toBeCloseTo(0.2);
    expect(monsterFleeChance(6)).toBeCloseTo(0.2);
    expect(monsterFleeChance(7)).toBe(0);
  });

  it('伤害至少 1，防守时防御翻倍', () => {
    expect(attackDamage(10, 3)).toBe(7);
    expect(attackDamage(10, 3, true)).toBe(4);
    expect(attackDamage(3, 10)).toBe(1);
  });

  it('玩家基础攻防随船与等级变化', () => {
    expect(playerAttackPower(0, 0)).toBe(6);
    expect(playerAttackPower(2, 5)).toBe(15);
    expect(playerDefense(0)).toBe(2);
    expect(playerDefense(3)).toBe(8);
  });
});
