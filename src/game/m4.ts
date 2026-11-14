/** M4 激励与治理：可单测的纯规则 */

export interface IslandScoreInput {
  visitCount: number;
  avgRating: number | null;
  ratingCount: number;
  resourcesTaken: number;
  daysSinceVisit: number;
}

/**
 * 岛屿评分（0–100）：
 * - 访问量 35：50 次访问记满
 * - 玩家评价 25：1 星=0，5 星=1；无评价按 0.5 中性
 * - 资源消耗 25：100 单位记满（说明玩家愿意在这儿花时间）
 * - 新鲜度 15：30 个世界日线性衰减
 */
export function islandScore(input: IslandScoreInput): number {
  const visit = Math.min(1, Math.max(0, input.visitCount) / 50);
  const rating =
    input.ratingCount > 0 && input.avgRating != null
      ? Math.min(1, Math.max(0, (input.avgRating - 1) / 4))
      : 0.5;
  const resources = Math.min(1, Math.max(0, input.resourcesTaken) / 100);
  const freshness = Math.max(0, 1 - Math.max(0, input.daysSinceVisit) / 30);
  return Math.round((visit * 35 + rating * 25 + resources * 25 + freshness * 15) * 10) / 10;
}

/** 创作者激励：按评分分档，0 表示不发放 */
export function rewardAmount(score: number): number {
  if (score >= 85) return 300;
  if (score >= 70) return 150;
  if (score >= 60) return 60;
  return 0;
}

/** 举报处置动作：手动复核时允许的动作 */
export const REPORT_ACTIONS = ['dismiss', 'warn', 'mute', 'ban'] as const;
export type ReportAction = (typeof REPORT_ACTIONS)[number];

export function isReportAction(value: string): value is ReportAction {
  return (REPORT_ACTIONS as readonly string[]).includes(value);
}
