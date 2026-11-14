import { angleDiff, distanceNm, movePoint } from '../game/geo';
import { CURRENT_ALIGN_TOLERANCE_DEG, GAME } from '../game/constants';

export interface MovePlanInput {
  x: number;
  y: number;
  angle: number;
  distance: number;
  shipSpeed: number;
  fuel: number;
  currentDirection: number;
  seaRadius: number;
}

export interface MovePlan {
  x: number;
  y: number;
  distance: number;
  hours: number;
  fuelUsed: number;
  alongCurrent: boolean;
  warnings: { type: string; text: string }[];
  /** 实际移动方位（罗盘） */
  bearing: number;
}

/**
 * 纯函数：移动与燃料/世界时间折算（§4.1、§4.2）。
 * - 单次移动最长 2 世界小时（20 海里），漂流 1 世界小时
 * - 航行每世界小时耗 1 单位燃料；与洋流夹角 ≤ 30° 视为顺流，不耗燃料
 * - 燃料不足时按剩余燃料缩短航程（不额外掉血；掉血惩罚待 M2 数值定案）
 * - 超出海域边界时沿海域边界截断
 */
export function planMove(input: MovePlanInput): MovePlan {
  const warnings: { type: string; text: string }[] = [];
  const shipSpeed = Math.max(1, input.shipSpeed);
  const maxDistance = Math.min(GAME.MAX_MOVE_DISTANCE_NM, shipSpeed * 2);

  let distance = Math.max(0, input.distance);
  if (distance > maxDistance) {
    warnings.push({
      type: 'distance_capped',
      text: `单次最多航行 ${Math.round(maxDistance)} 海里（约 2 世界小时），已按上限计算。`,
    });
    distance = maxDistance;
  }

  const alongCurrent = angleDiff(input.angle, input.currentDirection) <= CURRENT_ALIGN_TOLERANCE_DEG;
  let hours = distance / shipSpeed;
  let fuelUsed = alongCurrent ? 0 : hours * GAME.FUEL_PER_WORLD_HOUR;

  const fuel = Math.max(0, input.fuel);
  if (fuelUsed > fuel) {
    const availableHours = alongCurrent ? hours : fuel / GAME.FUEL_PER_WORLD_HOUR;
    const limitedDistance = Math.max(0, shipSpeed * availableHours);
    if (limitedDistance < distance - 0.001) {
      warnings.push({
        type: 'fuel_shortage',
        text: `燃料只够走 ${Math.round(limitedDistance * 10) / 10} 海里，剩下的航程取消了。`,
      });
    }
    distance = limitedDistance;
    hours = distance / shipSpeed;
    fuelUsed = Math.min(fuel, hours * GAME.FUEL_PER_WORLD_HOUR);
  }

  let { x, y } = movePoint(input.x, input.y, input.angle, distance);
  const fromCenter = Math.hypot(x, y);
  if (fromCenter > input.seaRadius) {
    const scale = input.seaRadius / fromCenter;
    x *= scale;
    y *= scale;
    warnings.push({ type: 'sea_boundary', text: '船头已经抵到当前海域的边界，再往外是测绘不到的水域。' });
    distance = distanceNm(input.x, input.y, x, y);
    hours = distance / shipSpeed;
    fuelUsed = alongCurrent ? 0 : hours * GAME.FUEL_PER_WORLD_HOUR;
  }

  const bearing = ((90 - input.angle) % 360 + 360) % 360;
  return {
    x,
    y,
    distance,
    hours,
    fuelUsed,
    alongCurrent,
    warnings,
    bearing,
  };
}
