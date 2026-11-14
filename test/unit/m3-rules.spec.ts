import { describe, expect, it } from 'vitest';
import {
  CAPTURE_MINUTES,
  captureComplete,
  captureProgress,
  crewFuelMultiplier,
  displayNameWithTeam,
  encounterAllowed,
  fatigueAfterOnline,
  fatigueAfterRecovery,
  learnableSkills,
  maxSelectableProtectionLevel,
  monsterActions,
  pickSkillByExperience,
  protectionActive,
  suddenDeathChance,
  DAILY_ONLINE_SECONDS,
} from '../../src/game/m3';

describe('M3 疲劳与猝死', () => {
  it('超出 8 小时后按每小时 10 点累加疲劳，且封顶 100', () => {
    expect(fatigueAfterOnline(0, DAILY_ONLINE_SECONDS)).toBe(0);
    expect(fatigueAfterOnline(0, DAILY_ONLINE_SECONDS + 3600)).toBe(10);
    expect(fatigueAfterOnline(50, DAILY_ONLINE_SECONDS + 3 * 3600)).toBe(80);
    expect(fatigueAfterOnline(95, DAILY_ONLINE_SECONDS + 10 * 3600)).toBe(100);
  });

  it('连续疲劳第 3 日 30%，随后每日 +25%，封顶 100%', () => {
    expect(suddenDeathChance(0)).toBe(0);
    expect(suddenDeathChance(2)).toBe(0);
    expect(suddenDeathChance(3)).toBeCloseTo(0.3, 5);
    expect(suddenDeathChance(4)).toBeCloseTo(0.55, 5);
    expect(suddenDeathChance(5)).toBeCloseTo(0.8, 5);
    expect(suddenDeathChance(9)).toBe(1);
  });

  it('每世界小时恢复 25%，不会低于 0', () => {
    expect(fatigueAfterRecovery(100, 1)).toBe(75);
    expect(fatigueAfterRecovery(100, 4)).toBe(0);
    expect(fatigueAfterRecovery(10, 4)).toBe(0);
  });
});

describe('M3 保护期', () => {
  it('保护期内只允许遭遇不超过自身 2 级的目标', () => {
    expect(protectionActive(1, 4)).toBe(true);
    expect(protectionActive(4, 4)).toBe(false);
    expect(encounterAllowed(1, 4, 3)).toBe(true);
    expect(encounterAllowed(1, 4, 4)).toBe(false);
    expect(encounterAllowed(5, 4, 7)).toBe(true);
  });

  it('可选保护等级取人数最多的等级', () => {
    expect(maxSelectableProtectionLevel({ 1: 5, 3: 5, 5: 2 })).toBe(3);
    expect(maxSelectableProtectionLevel({ 2: 9 })).toBe(2);
    expect(maxSelectableProtectionLevel({})).toBe(0);
  });
});

describe('M3 夺岛', () => {
  it('连续占领满 60 世界分钟即完成，跨日也正确', () => {
    expect(captureProgress(1, 100, 1, 130)).toBe(30);
    expect(captureComplete(1, 100, 1, 159)).toBe(false);
    expect(captureComplete(1, 100, 1, 160)).toBe(true);
    expect(captureProgress(1, 1400, 2, 20)).toBe(CAPTURE_MINUTES);
    expect(captureProgress(2, 20, 1, 1400)).toBe(0);
  });
});

describe('M3 团队', () => {
  it('移动消耗按人数放大，单人不变、上限 8', () => {
    expect(crewFuelMultiplier(0)).toBe(1);
    expect(crewFuelMultiplier(3)).toBe(3);
    expect(crewFuelMultiplier(20)).toBe(8);
  });

  it('队伍称号前缀只在开启时显示', () => {
    expect(displayNameWithTeam('阿七', '碎浪', true)).toBe('【碎浪】阿七');
    expect(displayNameWithTeam('阿七', '碎浪', false)).toBe('阿七');
    expect(displayNameWithTeam('阿七', null, true)).toBe('阿七');
  });
});

describe('M3 技能领悟', () => {
  it('仅在同等级技能中挑选，已学会的排除', () => {
    expect(learnableSkills('body', 3, []).map((s) => s.name)).toEqual(['蛮力']);
    expect(learnableSkills('body', 3, ['蛮力'])).toEqual([]);
    expect(learnableSkills('body', 2, [])).toEqual([]);
  });

  it('按最近经历标签命中数选择', () => {
    const candidates = learnableSkills('magic', 3, []);
    expect(pickSkillByExperience(candidates, ['fire'])?.name).toBe('水刃');
    const body = learnableSkills('body', 1, []);
    expect(pickSkillByExperience(body, ['defense'])?.name).toBe('铁皮');
    expect(pickSkillByExperience([], ['fire'])).toBeNull();
  });
});

describe('M3 怪物智慧', () => {
  it('低等级只会攻击，高等级解锁逃跑/集火/交谈/陷阱交易', () => {
    expect(monsterActions(1, 1)).toEqual(['attack']);
    expect(monsterActions(3, 0.2)).toContain('flee');
    expect(monsterActions(4, 1)).toContain('focus');
    expect(monsterActions(5, 1)).toContain('talk');
    expect(monsterActions(7, 1)).toContain('trade');
    expect(monsterActions(7, 1)).toContain('trap');
  });
});
