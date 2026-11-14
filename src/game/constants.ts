/**
 * 常量表（docs/M0-数据模型与接口定义.md §3 常量 + §4 待定参数建议初始值）。
 * 标注 §3 的为设计说明 v1.4 定稿值，不得擅自改动；标注 §4 的为 M1 先行值，调校时改这里。
 */
export const GAME = {
  // ---- §3 定稿常量 ----
  /** 1 世界日 = 8 现实小时 */
  REAL_MINUTES_PER_WORLD_DAY: 8 * 60,
  /** 1 世界分钟 = 20 现实秒 */
  REAL_SECONDS_PER_WORLD_MINUTE: 20,
  WORLD_MINUTES_PER_DAY: 1440,
  /** 白天 0–959 世界分钟（16 世界时），夜晚 960–1439（8 世界时） */
  DAY_MINUTES: 960,
  /** 战斗回合限时 15 秒 */
  COMBAT_ROUND_MS: 15000,
  /** 断线宽限期 30 秒 */
  DISCONNECT_GRACE_MS: 30000,
  /** 疲劳完全恢复 4 世界时 */
  FATIGUE_RECOVER_WORLD_HOURS: 4,
  /** 初始船速 10 海里/世界小时 */
  BASE_SHIP_SPEED: 10,
  /** 单次移动上限 2 世界小时 = 20 海里 */
  MAX_MOVE_DISTANCE_NM: 20,
  /** 随机漂流 1 世界小时 = 10 海里 */
  DRIFT_DISTANCE_NM: 10,
  /** 遭遇保证：2 世界小时内必定遭遇一座岛屿 */
  ENCOUNTER_GUARANTEE_MINUTES: 120,

  // ---- §4 待定参数（建议初始值）----
  /** 初始海域半径 50 海里 */
  INITIAL_SEA_RADIUS_NM: 50,
  /** 最小岛屿间距 15 海里 */
  MIN_ISLAND_DISTANCE_NM: 15,
  /** 出生区禁建半径 10 海里 */
  SPAWN_NO_BUILD_RADIUS_NM: 10,
  /** 燃料：航行每世界小时 1 单位；初始油箱 20 */
  FUEL_PER_WORLD_HOUR: 1,
  INITIAL_FUEL: 20,
  /** 每日 AI 调用预算 200 次 */
  AI_DAILY_BUDGET: 200,
  /** 岛屿总威胁度预算 50 + 10 × 世界日 */
  THREAT_BUDGET_BASE: 50,
  THREAT_BUDGET_PER_DAY: 10,
} as const;

/** 遭遇视野（M1 先行值；夜间视野更小，§3） */
export const ENCOUNTER_RANGE = {
  DAY_NM: 12,
  NIGHT_NM: 6,
} as const;

/** 洋流方向容差：与洋流夹角 ≤ 30° 视为顺流，不耗燃料（§4.1） */
export const CURRENT_ALIGN_TOLERANCE_DEG = 30;

/** 逃跑公式（§4.2） */
export const FLEE = {
  PLAYER_BASE: 0.5,
  PLAYER_SPEED_BONUS: 0.05,
  PLAYER_MAX: 0.9,
  PLAYER_MIN: 0.1,
  MONSTER_LOW_LEVEL: 0.5, // 1–3 级
  MONSTER_MID_LEVEL: 0.2, // 4–6 级
  /** 7 级不逃跑 */
} as const;

/** 高等级提示阈值（§3、§4.1：岛内存在高于自身 4 级者需提示） */
export const PROTECTION = {
  ENCOUNTER_LEVEL_GAP: 2,
  ISLAND_WARNING_LEVEL_GAP: 4,
} as const;

/** 红线类别（§4.4 六类） */
export const REDLINE_CATEGORIES = {
  sexual: '色情与性行为',
  minor_sexual: '涉及未成年人的性内容',
  abuse: '虐待行为',
  hate: '歧视与仇恨言论',
  gore: '极端血腥暴力细节',
  extremism: '现实极端主义与仇恨煽动',
} as const;

export type RedlineCategory = keyof typeof REDLINE_CATEGORIES;

/** 本局常量：规则上限，业务代码只从这里取值 */
export const APTITUDES = ['body', 'magic', 'light', 'dark', 'element', 'martial'] as const;
export type Aptitude = (typeof APTITUDES)[number];

export const DAY_NIGHT = { DAY: 'day', NIGHT: 'night' } as const;
export type DayNight = (typeof DAY_NIGHT)[keyof typeof DAY_NIGHT];
