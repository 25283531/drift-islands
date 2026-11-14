import { describe, expect, it } from 'vitest';
import { MENU_TEXT, parseDirection, parseDistance, parseIntent } from '../../src/game/commands';
import { extractIslandDraft } from '../../src/game/island-text';

describe('聊天室指令解析', () => {
  it('识别菜单、启航、攻击等关键词', () => {
    expect(parseIntent('菜单')).toBe('menu');
    expect(parseIntent('帮助')).toBe('menu');
    expect(parseIntent('启航')).toBe('sail');
    expect(parseIntent('我想出发')).toBe('sail');
    expect(parseIntent('攻击')).toBe('attack');
    expect(parseIntent('逃跑')).toBe('flee');
    expect(parseIntent('造岛')).toBe('island_create');
    expect(parseIntent('今天天气不错')).toBe('unknown');
  });

  it('方向支持数字与八方位', () => {
    expect(parseDirection('0')).toBe(0);
    expect(parseDirection('359')).toBe(359);
    expect(parseDirection('360')).toBeNull();
    expect(parseDirection('东北')).toBe(45);
    expect(parseDirection('西南')).toBe(225);
    expect(parseDirection('北偏东')).toBe(45);
    expect(parseDirection('往东')).toBe(90);
    expect(parseDirection('随便')).toBeNull();
  });

  it('航程取数字并限制范围', () => {
    expect(parseDistance('5')).toBe(5);
    expect(parseDistance('3.5 海里')).toBe(3.5);
    expect(parseDistance('0')).toBe(0.5);
    expect(parseDistance('99')).toBe(30);
    expect(parseDistance('远一点')).toBeNull();
  });

  it('菜单列出核心功能', () => {
    expect(MENU_TEXT).toContain('启航');
    expect(MENU_TEXT).toContain('造岛');
    expect(MENU_TEXT).toContain('攻击');
  });
});

describe('一段话造岛抽取', () => {
  it('从完整描述中抽出岛名、资源、怪物与等级', () => {
    const text =
      '这座岛叫碎桅岛，是一座搁浅的货轮，甲板歪着。规则：天黑后不要进船舱；淡水归岛主分配；不许在码头生火。岛上有废弃加油站，多燃料和零件。盘踞着 5 只溺尸，最高 3 级，集中在货舱。';
    const extracted = extractIslandDraft(text);
    expect(extracted.draft.name).toBe('碎桅岛');
    expect(extracted.draft.resource_direction).toContain('燃料');
    expect(extracted.draft.monsters?.[0]?.name).toBe('溺尸');
    expect(extracted.draft.monsters?.[0]?.count).toBe(5);
    expect(extracted.draft.monsters?.[0]?.max_level).toBe(3);
    expect(extracted.draft.rules?.length).toBeGreaterThanOrEqual(3);
  });

  it('信息不足时只追问缺口', () => {
    const extracted = extractIslandDraft('一座有很多药的岛');
    expect(extracted.draft.description).toBeTruthy();
    expect(extracted.missing.map((item) => item.id)).toContain('name');
    expect(extracted.missing.map((item) => item.id)).toContain('monsters');
  });
});
