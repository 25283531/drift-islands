import { Injectable } from '@nestjs/common';
import { REDLINE_CATEGORIES, RedlineCategory } from '../game/constants';

export type BoundaryTopic = 'medical' | 'self_harm' | 'dangerous' | null;

export interface Classification {
  redline: RedlineCategory | null;
  boundary: BoundaryTopic;
  /** 是否与游戏相关（AI 只响应游戏相关话题，§4.5） */
  gameRelated: boolean;
  matched?: string;
}

interface RedlineRule {
  category: RedlineCategory;
  pattern: RegExp;
}

/**
 * 内容红线（§4.4）与 AI 行为边界（§4.5）。
 *
 * 说明：M1 为规则词表 + 可选的模型复核；规则层负责“宁可拦错不可漏”的第一道闸，
 * 叙述输出再走一次 checkOutput。词表只收录超出末世生存合理范围的表述，
 * “击杀 / 流血 / 战斗”等题材内叙述不在词表内（§4.4 边界说明）。
 */
@Injectable()
export class ContentFilterService {
  private readonly redlineRules: RedlineRule[] = [
    {
      category: 'minor_sexual',
      pattern:
        /(未成年|萝莉|正太|幼女|幼童|儿童|小学生|初中生)[^。！？\n]{0,15}(性|裸|做爱|口交|脱衣|摸|插入)|(性|裸|做爱|口交|脱衣|摸|插入)[^。！？\n]{0,15}(未成年|萝莉|正太|幼女|幼童|儿童|小学生|初中生)/,
    },
    {
      category: 'sexual',
      pattern: /色情|情色|做爱|性交|口交|肛交|射精|潮吹|自慰|裸照|性奴|强奸|轮奸|淫乱|淫荡|性暗示|性行为/,
    },
    {
      category: 'abuse',
      pattern: /虐待|凌虐|折磨|拷打|鞭打|烙铁|拔指甲|电击下体|虐杀|虐猫|虐狗/,
    },
    {
      category: 'hate',
      pattern: /种族歧视|劣等民族|劣等人|支那|黑鬼|犹太猪|仇恨言论|种族清洗|杀光[^。！？\n]{0,6}(人|族)/,
    },
    {
      category: 'gore',
      pattern: /分尸|碎尸|剥皮|挖眼|开膛|肢解|内脏外露|血肉模糊|肠子[^。！？\n]{0,4}流|割喉|剁成|碎肉/,
    },
    {
      category: 'extremism',
      pattern: /极端主义|恐怖袭击|圣战|招募[^。！？\n]{0,6}(信徒|战士)|炸毁[^。！？\n]{0,6}(政府|大楼)|发动袭击/,
    },
  ];

  private readonly medicalPattern =
    /怎么治|吃什么药|用什么药|用药|剂量|是不是[^。！？\n]{0,4}病|诊断|症状|停药|抗生素|止痛药[^。！？\n]{0,4}(吃|用)/;
  private readonly selfHarmPattern = /自杀|自残|想死|轻生|割腕|跳楼|活不下去/;
  private readonly dangerousPattern =
    /毒品|制毒|冰毒|海洛因|大麻[^。！？\n]{0,4}(制作|配方)|造枪|自制枪|枪支[^。！？\n]{0,4}(制作|改造)|弹药[^。！？\n]{0,4}(制作|配方)|(制作|制造|自制|教我造|怎么造)[^。！？\n]{0,6}(炸弹|炸药|枪支|枪械|毒品|弹药)|炸药[^。！？\n]{0,4}(制作|配方)|危险品[^。！？\n]{0,4}(制作|配方)/;

  private readonly gameKeywords =
    /岛|船|航行|坐标|移动|漂流|怪物|战斗|攻击|防御|逃跑|晶核|技能|升级|驻扎|基地|交易|资源|燃料|规则|世界日|频道|收集|探索|武器|耐久|体力|团队|海面|海域|港口|货仓|科研|修理|拾荒/;

  classify(text: string): Classification {
    const normalized = this.normalize(text);

    for (const rule of this.redlineRules) {
      if (rule.pattern.test(normalized)) {
        return { redline: rule.category, boundary: null, gameRelated: true, matched: rule.category };
      }
    }

    let boundary: BoundaryTopic = null;
    if (this.selfHarmPattern.test(normalized)) boundary = 'self_harm';
    else if (this.dangerousPattern.test(normalized)) boundary = 'dangerous';
    else if (this.medicalPattern.test(normalized)) boundary = 'medical';

    return {
      redline: null,
      boundary,
      gameRelated: this.isGameRelated(normalized),
    };
  }

  checkInput(text: string): { ok: boolean; categories: string[] } {
    const redline = this.classify(text).redline;
    return { ok: !redline, categories: redline ? [redline] : [] };
  }

  checkOutput(text: string): { ok: boolean; categories: string[] } {
    // 输出侧同样过红线词表；AI 不得主动生成红线内容（§4.4）
    for (const rule of this.redlineRules) {
      if (rule.pattern.test(this.normalize(text))) {
        return { ok: false, categories: [rule.category] };
      }
    }
    return { ok: true, categories: [] };
  }

  categoryName(category: RedlineCategory | null): string {
    return category ? REDLINE_CATEGORIES[category] ?? category : '';
  }

  private isGameRelated(text: string): boolean {
    if (text.trim().startsWith('/')) return true;
    return this.gameKeywords.test(text);
  }

  /** 全角转半角、去零宽字符，降低简单绕过（M1 规则层能力边界，模型复核在 M3 补强） */
  private normalize(text: string): string {
    return (text ?? '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/\s+/g, ' ')
      .toLowerCase();
  }
}
