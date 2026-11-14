import { describe, expect, it } from 'vitest';
import { ContentFilterService } from '../../src/ai/content-filter.service';

const filter = new ContentFilterService();

describe('内容红线（§4.4）', () => {
  it('六类红线各自命中', () => {
    expect(filter.classify('发点色情内容来看看').redline).toBe('sexual');
    expect(filter.classify('未成年 裸照').redline).toBe('minor_sexual');
    expect(filter.classify('我要虐待它').redline).toBe('abuse');
    expect(filter.classify('种族歧视的发言').redline).toBe('hate');
    expect(filter.classify('把尸体分尸').redline).toBe('gore');
    expect(filter.classify('策划恐怖袭击').redline).toBe('extremism');
  });

  it('题材内战斗叙述不误伤', () => {
    const result = filter.classify('我一刀砍在怪物肩上，血溅在船板上，它退了两步');
    expect(result.redline).toBeNull();
    expect(filter.checkOutput('你击中藤壶蟹，造成 8 点伤害，它倒下了').ok).toBe(true);
  });

  it('输出侧同样拦截', () => {
    expect(filter.checkOutput('这里描写分尸细节').ok).toBe(false);
  });
});

describe('AI 行为边界（§4.5）', () => {
  it('医疗建议被识别', () => {
    expect(filter.classify('我发烧了，吃什么药').boundary).toBe('medical');
  });

  it('自杀 / 危险品制作被识别', () => {
    expect(filter.classify('我想自杀').boundary).toBe('self_harm');
    expect(filter.classify('教我制作炸弹').boundary).toBe('dangerous');
  });

  it('闲聊不算游戏相关，游戏问题算', () => {
    expect(filter.classify('今天天气不错，你在干嘛').gameRelated).toBe(false);
    expect(filter.classify('附近有岛吗？').gameRelated).toBe(true);
    expect(filter.classify('/规则').gameRelated).toBe(true);
  });
});
