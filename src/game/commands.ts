/**
 * 聊天室文字指令解析（M3.5 交互改造）。
 * 纯函数，便于单测；网关只负责执行与回话。
 */

export type CommandIntent =
  | 'menu'
  | 'sail'
  | 'drift'
  | 'nearby'
  | 'enter'
  | 'leave'
  | 'attack'
  | 'defend'
  | 'flee'
  | 'status'
  | 'collect'
  | 'skills'
  | 'team'
  | 'team_info'
  | 'trade'
  | 'island_create'
  | 'confirm'
  | 'cancel'
  | 'unknown';

const RULES: { intent: CommandIntent; words: string[] }[] = [
  { intent: 'menu', words: ['菜单', '帮助', '功能', '指令', '命令', '怎么玩'] },
  { intent: 'island_create', words: ['造岛', '建岛', '创建岛', '造一座岛'] },
  { intent: 'confirm', words: ['确认', '确定', '就这样', '可以'] },
  { intent: 'cancel', words: ['取消', '算了', '放弃'] },
  { intent: 'sail', words: ['启航', '航行', '出发', '开船', '起航'] },
  { intent: 'drift', words: ['漂流', '随浪', '随波'] },
  { intent: 'nearby', words: ['附近', '周围', '看看四周', '周边'] },
  { intent: 'enter', words: ['上岛', '进岛', '登岛', '上岸'] },
  { intent: 'leave', words: ['离岛', '回船', '上船离开'] },
  { intent: 'attack', words: ['攻击', '打它', '开火', '砍'] },
  { intent: 'defend', words: ['防御', '防守', '守住', '格挡'] },
  { intent: 'flee', words: ['逃跑', '撤退', '跑'] },
  { intent: 'status', words: ['状态', '我是谁', '我的信息', '面板'] },
  { intent: 'collect', words: ['搜刮', '收集', '捡', '搜寻'] },
  { intent: 'skills', words: ['技能', '领悟'] },
  { intent: 'team_info', words: ['队伍', '队友', '团队信息'] },
  { intent: 'team', words: ['组队', '建队', '创建队伍'] },
  { intent: 'trade', words: ['交易', '交换', '换东西'] },
];

export function parseIntent(raw: string): CommandIntent {
  const text = (raw ?? '').trim();
  if (!text) return 'unknown';
  for (const rule of RULES) {
    if (rule.words.some((word) => text === word || text.startsWith(word))) return rule.intent;
  }
  // 口语补充：“我想出发”“往前开”
  if (/出发|往前开|开出去/.test(text)) return 'sail';
  if (/看看周围|有岛吗/.test(text)) return 'nearby';
  return 'unknown';
}

/** 菜单正文：功能与示例，尽量短 */
export const MENU_TEXT = [
  '可用操作（直接发关键词）：',
  '· 启航 — 我接着问方向与航程',
  '· 漂流 — 随洋流走一段',
  '· 附近 — 看周围有没有岛',
  '· 上岛 / 离岛',
  '· 攻击 / 防御 / 逃跑 — 战斗中可用',
  '· 搜刮 — 在岛上找物资',
  '· 造岛 — 用一段话描述你的岛',
  '· 组队 / 队伍 / 技能 / 交易 / 状态',
  '随时发「菜单」回到这里。',
].join('\n');

const COMPASS: Record<string, number> = {
  北: 0,
  东北: 45,
  东: 90,
  东南: 135,
  南: 180,
  西南: 225,
  西: 270,
  西北: 315,
};

/** 方向：0–359 数字，或 北/东北/东…，可带“偏” */
export function parseDirection(raw: string): number | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  const numeric = /^(\d{1,3})(?:\s*度|°)?$/.exec(text);
  if (numeric) {
    const value = Number(numeric[1]);
    if (value >= 0 && value <= 359) return value;
    return null;
  }
  const compact = text.replace(/[方向朝往\s]/g, '');
  if (COMPASS[compact] !== undefined) return COMPASS[compact];
  // “东北偏东30”这类：取主方向再按偏转加减
  const match = /^(北|南|东|西|东北|东南|西北|西南)(?:偏(北|南|东|西))?(\d{1,2})?/.exec(compact);
  if (!match) return null;
  let base = COMPASS[match[1]];
  if (base === undefined) return null;
  if (match[2]) {
    const offset: Record<string, Record<string, number>> = {
      北: { 东: 45, 西: -45 },
      南: { 东: -45, 西: 45 },
      东: { 北: -45, 南: 45 },
      西: { 北: 45, 南: -45 },
    };
    base += offset[match[1]]?.[match[2]] ?? 0;
  }
  return ((base % 360) + 360) % 360;
}

/** 航程：取第一个数字，限制 0.5–30 海里 */
export function parseDistance(raw: string): number | null {
  const match = /(\d+(?:\.\d+)?)/.exec(raw ?? '');
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  return Math.min(30, Math.max(0.5, value));
}

/** 是否像一个方向回答（用于“启航”后的追问态） */
export function looksLikeDirection(raw: string): boolean {
  return parseDirection(raw) !== null;
}
