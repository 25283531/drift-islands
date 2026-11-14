/** 环境变量读取（集中管理，避免各模块散读 process.env） */
export function envStr(key: string, fallback = ''): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

export function envInt(key: string, fallback: number): number {
  const v = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
}

export function envFloat(key: string, fallback: number): number {
  const v = Number.parseFloat(process.env[key] ?? '');
  return Number.isFinite(v) ? v : fallback;
}

export function envBool(key: string, fallback = false): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

/** 世界分钟 → “世界日 X · HH:00（白天/夜晚）” */
export function formatWorldMinutes(worldMinutes: number): string {
  const hour = Math.floor(worldMinutes / 60);
  const minute = worldMinutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
