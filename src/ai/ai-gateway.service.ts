import { Injectable, Logger } from '@nestjs/common';
import { envInt, envStr } from '../common/env';

export class AiUnavailableError extends Error {}

export interface CallOptions {
  temperature?: number;
  maxTokens?: number;
  /** 使用大参数模型（世界演变 / 7 级怪物 / 关键裁决润色） */
  tier?: 'small' | 'large';
}

/**
 * AI 网关（§4.3）：只负责调用，路由与配额由上层决定。
 * 兼容 OpenAI /chat/completions 协议；未配置密钥时抛 AiUnavailableError，
 * 上层（NarratorService）自动降级为模板叙述。
 */
@Injectable()
export class AiGatewayService {
  private readonly logger = new Logger(AiGatewayService.name);
  private readonly baseUrl = envStr('AI_BASE_URL');
  private readonly apiKey = envStr('AI_API_KEY');
  private readonly smallModel = envStr('AI_MODEL_SMALL', envStr('AI_MODEL_LARGE'));
  private readonly largeModel = envStr('AI_MODEL_LARGE', envStr('AI_MODEL_SMALL'));
  private readonly timeoutMs = envInt('AI_TIMEOUT_MS', 20000);

  get available(): boolean {
    return Boolean(this.baseUrl && this.apiKey && (this.smallModel || this.largeModel));
  }

  get tierModels(): { small: string; large: string } {
    return { small: this.smallModel, large: this.largeModel };
  }

  async call(purpose: string, prompt: string, opts: CallOptions = {}): Promise<string> {
    if (!this.available) throw new AiUnavailableError('AI 网关未配置');
    const tier = opts.tier ?? 'small';
    const model = tier === 'large' ? this.largeModel : this.smallModel;
    if (!model) throw new AiUnavailableError(`模型池缺少 ${tier} 模型`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content:
                '你是末世海上漂流文字游戏的世界叙述者。只输出与游戏世界有关的叙述，简洁、具体、有画面感；' +
                '不输出解释、不输出 markdown、不使用现实人物；不生成色情、虐待、歧视、极端血腥或极端主义内容。',
            },
            { role: 'user', content: prompt },
          ],
          temperature: opts.temperature ?? 0.8,
          max_tokens: opts.maxTokens ?? 220,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`AI HTTP ${res.status}`);
      }
      const data: any = await res.json();
      const text: string = data?.choices?.[0]?.message?.content ?? '';
      if (!text.trim()) throw new Error('AI 返回空内容');
      return text.trim();
    } catch (err) {
      this.logger.warn(`AI 调用失败（${purpose}）：${(err as Error).message}`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
