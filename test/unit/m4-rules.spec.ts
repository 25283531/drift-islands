import { describe, expect, it } from 'vitest';
import { islandScore, rewardAmount, isReportAction } from '../../src/game/m4';

describe('M4 岛屿评分', () => {
  it('满访问 + 五星 + 满资源 + 当天 = 100 分', () => {
    expect(
      islandScore({ visitCount: 50, avgRating: 5, ratingCount: 3, resourcesTaken: 100, daysSinceVisit: 0 }),
    ).toBe(100);
  });

  it('无访问无资源但当天有人看过，不会掉到 0', () => {
    const score = islandScore({ visitCount: 0, avgRating: null, ratingCount: 0, resourcesTaken: 0, daysSinceVisit: 0 });
    expect(score).toBeCloseTo(27.5, 1);
  });

  it('30 天没人来，新鲜度归零', () => {
    expect(
      islandScore({ visitCount: 50, avgRating: 5, ratingCount: 1, resourcesTaken: 100, daysSinceVisit: 30 }),
    ).toBe(85);
  });

  it('激励按分档发放', () => {
    expect(rewardAmount(85)).toBe(300);
    expect(rewardAmount(84.9)).toBe(150);
    expect(rewardAmount(70)).toBe(150);
    expect(rewardAmount(60)).toBe(60);
    expect(rewardAmount(59.9)).toBe(0);
  });

  it('举报动作白名单', () => {
    expect(isReportAction('mute')).toBe(true);
    expect(isReportAction('delete')).toBe(false);
  });
});
