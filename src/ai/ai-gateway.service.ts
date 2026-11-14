import { Injectable, Logger } from '@nestjs/common';
import { envInt, envStr } from '../common/env';

export class AiUnavailableError extends Error {}

export interface CallOptions {
  temperature?: number;
  maxTokens?: number;
  /** 大参数模型（世界演变 / 7 级怪物 / 关键裁决润色） */
  tier?: 'small' | 'large';
}

interface Endpoint {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  tier: 'small' | 'large';
  cooldownUntil: number;
  failures: number;
  calls: number;
}

const DEFAULT_SMALL_NVIDIA = ['meta/llama-3.1-8b-instruct', 'mistralai/mistral-7b-instruct-v0.3', 'microsoft/phi-3-mini-128k-instruct'];
const DEFAULT_LARGE_NVIDIA = ['meta/llama-3.3-70b-instruct', 'nvidia/llama-3.1-nemotron-70b-instruct'];
const DEFAULT_SMALL_OPENROUTER = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'qwen/qwen-2.5-72b-instruct:free',
  'google/gemma-2-9b-it:free',
  'mistralai/mistral-small-3.2-24b-instruct:free',
];
const DEFAULT_LARGE_OPENROUTER = [
  'deepseek/deepseek-chat-v3-0324:free',
  'meta-llama/llama-3.3-70b-instruct:free',
];

const PROVIDER_RANK: Record<string, number> = { siliconflow: 0, nvidia: 1, openrouter: 2, custom: 3 };

function providerRank(provider: string): number {
  return PROVIDER_RANK[provider] ?? 5;
}

function splitList(value: string): string[] {
  return value
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 解析 `small:model,large:model`；无前缀默认 small */
function parseModels(raw: string, fallbackSmall: string[], fallbackLarge: string[]): { tier: 'small' | 'large'; model: string }[] {
  const entries = splitList(raw);
  if (entries.length === 0) {
    return [
      ...fallbackSmall.map((model) => ({ tier: 'small' as const, model })),
      ...fallbackLarge.map((model) => ({ tier: 'large' as const, model })),
    ];
  }
  return entries.map((entry) => {
    const match = /^(small|large)\s*:\s*(.+)$/i.exec(entry);
    if (match) return { tier: match[1].toLowerCase() as 'small' | 'large', model: match[2].trim() };
    return { tier: 'small' as const, model: entry };
  });
}

/**
 * AI 网关（§4.3）：只负责调用；路由、降级、配额由上层负责。
 * 支持多家 OpenAI 兼容服务（英伟达 NIM / OpenRouter），同层多模型，
 * 单个模型失败（限流 / 5xx / 超时）自动切换下一个，并冷却 60 秒。
 */
@Injectable()
export class AiGatewayService {
  private readonly logger = new Logger(AiGatewayService.name);
  private readonly endpoints: Endpoint[];
  private readonly timeoutMs = envInt('AI_TIMEOUT_MS', 8000);

  constructor() {
    this.endpoints = this.buildEndpoints();
    if (this.endpoints.length > 0) {
      const summary = this.endpoints.map((e) => `${e.provider}:${e.model}(${e.tier})`).join(', ');
      this.logger.log(`AI 模型池已加载 ${this.endpoints.length} 个模型：${summary}`);
    } else {
      this.logger.warn('AI 模型池为空：叙述将全部走模板');
    }
  }

  private buildEndpoints(): Endpoint[] {
    const list: Endpoint[] = [];

    const nvidiaKeys = splitList(envStr('NVIDIA_API_KEYS', '') || envStr('NVIDIA_API_KEY', ''));
    const nvidiaBase = envStr('NVIDIA_BASE_URL', 'https://integrate.api.nvidia.com/v1');
    const nvidiaModels = parseModels(envStr('NVIDIA_MODELS', ''), DEFAULT_SMALL_NVIDIA, DEFAULT_LARGE_NVIDIA);
    for (const key of nvidiaKeys) {
      for (const entry of nvidiaModels) {
        list.push({
          provider: 'nvidia',
          baseUrl: nvidiaBase,
          apiKey: key,
          model: entry.model,
          tier: entry.tier,
          cooldownUntil: 0,
          failures: 0,
          calls: 0,
        });
      }
    }

    const openrouterKeys = splitList(envStr('OPENROUTER_API_KEYS', '') || envStr('OPENROUTER_API_KEY', ''));
    const openrouterBase = envStr('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1');
    const openrouterModels = parseModels(
      envStr('OPENROUTER_MODELS', ''),
      DEFAULT_SMALL_OPENROUTER,
      DEFAULT_LARGE_OPENROUTER,
    );
    for (const key of openrouterKeys) {
      for (const entry of openrouterModels) {
        list.push({
          provider: 'openrouter',
          baseUrl: openrouterBase,
          apiKey: key,
          model: entry.model,
          tier: entry.tier,
          cooldownUntil: 0,
          failures: 0,
          calls: 0,
        });
      }
    }

    // 硅基流动（SiliconFlow）：免费额度较宽松，作为小模型主力
    const siliconKeys = splitList(envStr('SILICONFLOW_API_KEYS', '') || envStr('SILICONFLOW_API_KEY', ''));
    const siliconBase = envStr('SILICONFLOW_BASE_URL', 'https://api.siliconflow.cn/v1');
    const siliconModels = parseModels(
      envStr('SILICONFLOW_MODELS', ''),
      ['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-14B-Instruct'],
      ['Qwen/Qwen2.5-72B-Instruct'],
    );
    if (siliconKeys.length > 0) {
      for (const key of siliconKeys) {
        for (const entry of siliconModels) {
          list.push({
            provider: 'siliconflow',
            baseUrl: siliconBase,
            apiKey: key,
            model: entry.model,
            tier: entry.tier,
            cooldownUntil: 0,
            failures: 0,
            calls: 0,
          });
        }
      }
    }

    // 兼容旧的单模型配置
    const legacyBase = envStr('AI_BASE_URL');
    const legacyKey = envStr('AI_API_KEY');
    if (legacyBase && legacyKey) {
      const small = envStr('AI_MODEL_SMALL', envStr('AI_MODEL_LARGE'));
      const large = envStr('AI_MODEL_LARGE', envStr('AI_MODEL_SMALL'));
      if (small) list.push({ provider: 'custom', baseUrl: legacyBase, apiKey: legacyKey, model: small, tier: 'small', cooldownUntil: 0, failures: 0, calls: 0 });
      if (large && large !== small) list.push({ provider: 'custom', baseUrl: legacyBase, apiKey: legacyKey, model: large, tier: 'large', cooldownUntil: 0, failures: 0, calls: 0 });
    }

    return list;
  }

  get available(): boolean {
    return this.endpoints.length > 0;
  }

  /** 诊断用：不返回密钥 */
  describe(): { provider: string; model: string; tier: string; calls: number; failures: number; cooling: boolean }[] {
    return this.endpoints.map((e) => ({
      provider: e.provider,
      model: e.model,
      tier: e.tier,
      calls: e.calls,
      failures: e.failures,
      cooling: e.cooldownUntil > Date.now(),
    }));
  }

  get tierModels(): { small: string; large: string } {
    return {
      small: this.endpoints.find((e) => e.tier === 'small')?.model ?? '',
      large: this.endpoints.find((e) => e.tier === 'large')?.model ?? '',
    };
  }

  private candidates(tier: 'small' | 'large'): Endpoint[] {
    const now = Date.now();
    const sameTier = this.endpoints.filter((e) => e.tier === tier);
    const other = this.endpoints.filter((e) => e.tier !== tier);
    // 同层优先；冷却中的剔除；失败少的优先；硅基流动额度宽裕，排在同层前面
    return [...sameTier, ...other]
      .filter((e) => e.cooldownUntil <= now)
      .sort(
        (a, b) =>
          providerRank(a.provider) - providerRank(b.provider) ||
          a.failures - b.failures ||
          a.calls - b.calls,
      );
  }

  async call(purpose: string, prompt: string, opts: CallOptions = {}): Promise<string> {
    if (this.endpoints.length === 0) throw new AiUnavailableError('AI 网关未配置');
    const tier = opts.tier ?? 'small';
    const candidates = this.candidates(tier);
    if (candidates.length === 0) throw new AiUnavailableError('所有模型都在冷却中');

    let lastError: Error | null = null;
    for (const endpoint of candidates.slice(0, 3)) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      endpoint.calls += 1;
      try {
        const res = await fetch(`${endpoint.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${endpoint.apiKey}`,
            ...(endpoint.provider === 'openrouter'
              ? { 'HTTP-Referer': 'https://github.com/25283531/drift-islands', 'X-Title': 'drift-islands' }
              : {}),
          },
          body: JSON.stringify({
            model: endpoint.model,
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
          const body = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status} ${body.slice(0, 120)}`);
        }
        const data: any = await res.json();
        const text: string = data?.choices?.[0]?.message?.content ?? '';
        if (!text.trim()) throw new Error('空内容');
        endpoint.failures = 0;
        this.logger.debug(`AI 成功：${endpoint.provider}/${endpoint.model}（${purpose}）`);
        return text.trim();
      } catch (err) {
        lastError = err as Error;
        endpoint.failures += 1;
        endpoint.cooldownUntil = Date.now() + 60_000;
        this.logger.warn(`AI 失败，切换下一个：${endpoint.provider}/${endpoint.model} ${lastError.message}`);
      } finally {
        clearTimeout(timer);
      }
    }
    throw new AiUnavailableError(lastError?.message ?? '所有模型调用失败');
  }
}
