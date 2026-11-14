/** 坐标与方位工具（海域为二维连续平面，单位海里，§3） */

export function distanceNm(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

/** 罗盘方位：0 = 正北，顺时针（90 = 正东） */
export function bearingDeg(ax: number, ay: number, bx: number, by: number): number {
  const rad = Math.atan2(bx - ax, by - ay);
  return ((rad * 180) / Math.PI + 360) % 360;
}

const DIRECTION_NAMES = [
  '正北',
  '东北偏北',
  '东北',
  '东北偏东',
  '正东',
  '东南偏东',
  '东南',
  '东南偏南',
  '正南',
  '西南偏南',
  '西南',
  '西南偏西',
  '正西',
  '西北偏西',
  '西北',
  '西北偏北',
];

export function bearingText(deg: number): string {
  const idx = Math.round(((deg % 360) + 360) % 360 / 22.5) % 16;
  return DIRECTION_NAMES[idx];
}

/** 移动方向角（0 = 正东，逆时针），转换为罗盘方位 */
export function headingToBearing(angle: number): number {
  return ((90 - angle) % 360 + 360) % 360;
}

export function normalizeAngle(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

export function angleDiff(a: number, b: number): number {
  const diff = Math.abs(normalizeAngle(a) - normalizeAngle(b));
  return Math.min(diff, 360 - diff);
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** 从 (x,y) 沿角度移动 distance 海里 */
export function movePoint(x: number, y: number, angleDeg: number, distance: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: x + Math.cos(rad) * distance, y: y + Math.sin(rad) * distance };
}
