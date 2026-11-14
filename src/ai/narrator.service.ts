import { Injectable, Logger } from '@nestjs/common';
import { AiGatewayService } from './ai-gateway.service';
import { ContentFilterService } from './content-filter.service';
import { QuotaService } from './quota.service';
import { KvService } from '../redis/kv.service';
import { round1 } from '../game/geo';

export type NarrationKind =
  | 'sail'
  | 'drift'
  | 'encounter'
  | 'enter_island'
  | 'leave_island'
  | 'combat_round'
  | 'combat_victory'
  | 'combat_defeat'
  | 'death'
  | 'revive'
  | 'ai_chat';

export interface NarrateOptions {
  userId?: string;
  tier?: 'small' | 'large';
  /** 缓存键（同一岛屿场景等可复用） */
  cacheKey?: string;
}

export interface NarrationResult {
  text: string;
  source: 'template' | 'llm';
  degraded: boolean;
}

/**
 * 叙述器（§4.3）：模板优先 + 必要时 LLM 润色 + 内容复核。
 * - 无模型密钥 / 超预算 / 调用失败 / 输出违规 → 一律用模板，保证玩法不中断。
 * - 模板本身也过一遍红线检查（防御性）。
 */
@Injectable()
export class NarratorService {
  private readonly logger = new Logger(NarratorService.name);

  constructor(
    private readonly gateway: AiGatewayService,
    private readonly filter: ContentFilterService,
    private readonly quota: QuotaService,
    private readonly kv: KvService,
  ) {}

  async render(kind: NarrationKind, ctx: Record<string, any> = {}, opts: NarrateOptions = {}): Promise<NarrationResult> {
    const template = this.template(kind, ctx);

    if (opts.cacheKey) {
      const cached = await this.kv.get(`cache:narration:${opts.cacheKey}`);
      if (cached) return { text: cached, source: 'template', degraded: false };
    }

    let degraded = false;
    if (opts.userId) {
      const status = await this.quota.status(opts.userId);
      if (!status.allowed) degraded = true;
    }

    if (this.gateway.available && opts.userId && !degraded) {
      try {
        const polished = await this.gateway.call(
          `narration:${kind}`,
          this.prompt(kind, template, ctx),
          { tier: opts.tier ?? 'small', maxTokens: 200, temperature: 0.85 },
        );
        const check = this.filter.checkOutput(polished);
        if (check.ok) {
          await this.quota.record(opts.userId);
          if (opts.cacheKey) await this.kv.set(`cache:narration:${opts.cacheKey}`, polished, 600);
          return { text: polished, source: 'llm', degraded: false };
        }
        this.logger.warn(`AI 叙述命中红线，已回退模板：${check.categories.join(',')}`);
      } catch {
        /* 调用失败回退模板 */
      }
    }

    if (opts.cacheKey) await this.kv.set(`cache:narration:${opts.cacheKey}`, template, 600);
    const safe = this.filter.checkOutput(template);
    return {
      text: safe.ok ? template : '海面安静得反常，你没有看清刚才发生了什么。',
      source: 'template',
      degraded,
    };
  }

  private prompt(kind: NarrationKind, template: string, ctx: Record<string, any>): string {
    return [
      `场景类型：${kind}`,
      `已由系统确定的数字与事实（不得改写）：${JSON.stringify(ctx)}`,
      `底稿：${template}`,
      '请在不改动任何数字、结果、坐标的前提下润色为 1–2 句中文叙述。不要添加新的事件或物品。',
    ].join('\n');
  }

  private template(kind: NarrationKind, ctx: Record<string, any>): string {
    switch (kind) {
      case 'sail':
        return (
          `你把舵转向${ctx.direction_text}，${round1(ctx.distance ?? 0)} 海里后，` +
          `海面${ctx.scenery ?? '只剩一层灰白的浪'}。` +
          `这一程耗去 ${round1(ctx.hours ?? 0)} 个世界小时，${String(ctx.fuel_text ?? '燃料略有消耗').replace(/。$/, '')}。` +
          `${ctx.boundary_text ?? ''}`
        );
      case 'drift':
        return (
          `你松开舵，让船随浪漂。船头慢慢转到${ctx.direction_text}，` +
          `一个世界小时后，${round1(ctx.distance ?? 0)} 海里的海面被抛在身后。${ctx.fuel_text ?? '这次漂流没有烧油。'}`
        );
      case 'encounter':
        return `前方 ${round1(ctx.distance ?? 0)} 海里的雾里浮出一座岛的轮廓——${ctx.name}。${ctx.hint ?? ''}`;
      case 'enter_island':
        return (
          `你靠上${ctx.name}的浅滩，缆绳一扔，船身撞在锈蚀的桩上。${ctx.description ?? ''}` +
          `${ctx.monster_text ?? ''}`
        );
      case 'leave_island':
        return `你解开缆绳，把${ctx.name}留在身后的雾里。船回到开阔海面。`;
      case 'combat_round':
        return `第 ${ctx.round} 回合：${ctx.events?.length ? ctx.events.join('；') : '双方都在试探'}。`;
      case 'combat_victory':
        return `最后一只怪物倒下。${ctx.detail ?? '岛上安静下来，只剩下浪拍铁皮的声音。'}`;
      case 'combat_defeat':
        return `你被打倒了，视野里只剩晃动的水面和铁锈味。${ctx.detail ?? ''}`;
      case 'death':
        return `你死了。身上的东西散落在${ctx.place ?? '原地'}，海会替你保管一阵子。`;
      case 'revive':
        return `你在一条和出发时一样的初始船上醒来，船漂在随机的一片海上。世界日 ${ctx.world_day ?? '?'}。`;
      case 'ai_chat':
        return ctx.text ?? '海风把话吹散了。';
      default:
        return ctx.text ?? '';
    }
  }
}
