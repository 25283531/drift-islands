import { describe, expect, it } from 'vitest';
import { planMove } from '../../src/movement/movement.plan';

const base = {
  x: 0,
  y: 0,
  angle: 0,
  distance: 20,
  shipSpeed: 10,
  fuel: 20,
  currentDirection: 180,
  seaRadius: 50,
};

describe('planMove：移动 / 世界时间 / 燃料折算（§4.1、§4.2）', () => {
  it('单次 20 海里 = 2 世界小时，逆流每世界小时耗 1 燃料', () => {
    const plan = planMove({ ...base, angle: 0, currentDirection: 180 });
    expect(plan.distance).toBe(20);
    expect(plan.hours).toBeCloseTo(2);
    expect(plan.fuelUsed).toBeCloseTo(2);
    expect(plan.alongCurrent).toBe(false);
    expect(plan.x).toBeCloseTo(20);
  });

  it('顺洋流（夹角 ≤ 30°）不耗燃料', () => {
    const plan = planMove({ ...base, angle: 0, currentDirection: 20 });
    expect(plan.alongCurrent).toBe(true);
    expect(plan.fuelUsed).toBe(0);
    expect(plan.distance).toBe(20);
  });

  it('超过 2 世界小时上限时按 20 海里截断并提示', () => {
    const plan = planMove({ ...base, shipSpeed: 30, distance: 90, currentDirection: 180 });
    expect(plan.distance).toBe(20);
    expect(plan.warnings.some((w) => w.type === 'distance_capped')).toBe(true);
  });

  it('燃料不足时按剩余燃料缩短航程', () => {
    const plan = planMove({ ...base, distance: 20, fuel: 1, currentDirection: 180 });
    expect(plan.distance).toBeCloseTo(10);
    expect(plan.fuelUsed).toBeCloseTo(1);
    expect(plan.warnings.some((w) => w.type === 'fuel_shortage')).toBe(true);
  });

  it('触到海域边界时沿海域边界截断并提示', () => {
    const plan = planMove({ ...base, x: 45, y: 0, angle: 0, distance: 20, currentDirection: 180 });
    expect(plan.x).toBeCloseTo(50);
    expect(plan.warnings.some((w) => w.type === 'sea_boundary')).toBe(true);
    expect(plan.distance).toBeCloseTo(5);
  });

  it('方位角换算：0° 向东 = 罗盘 90°', () => {
    const plan = planMove({ ...base, angle: 0, distance: 1 });
    expect(plan.bearing).toBeCloseTo(90);
  });
});
