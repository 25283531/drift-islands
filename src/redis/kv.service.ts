import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { envStr } from '../common/env';

interface MemEntry {
  value: string;
  expiresAt?: number;
}

/**
 * Redis 键（§1.23）：
 * - `presence:<characterId>`       在线状态（online / grace / offline）
 * - `encounter:char:<characterId>` 连续航行未遭遇的世界分钟数（遭遇兜底）
 * - `mute:<userId>`                禁言到时（TTL）
 * - `quota:<userId>:<date>`        当日 AI 调用计数（与 ai_quotas 同步）
 * - `cache:narration:<key>`        叙述缓存
 *
 * 未配置 REDIS_URL 时退化为进程内实现（单实例开发 / 测试可用），
 * 多实例部署必须配置 Redis，否则在线状态与配额不共享。
 */
@Injectable()
export class KvService implements OnModuleDestroy {
  private readonly logger = new Logger(KvService.name);
  private client: Redis | null = null;
  private readonly memory = new Map<string, MemEntry>();
  readonly mode: 'redis' | 'memory';

  constructor() {
    const url = envStr('REDIS_URL');
    if (!url) {
      this.mode = 'memory';
      return;
    }
    this.mode = 'redis';
    this.client = new Redis(url, {
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    this.client.on('error', (err) => {
      this.logger.warn(`Redis 不可用，降级为进程内存储：${err.message}`);
      if (this.client) {
        this.client.disconnect();
        this.client = null;
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
  }

  private memGet(key: string): string | null {
    const hit = this.memory.get(key);
    if (!hit) return null;
    if (hit.expiresAt && hit.expiresAt <= Date.now()) {
      this.memory.delete(key);
      return null;
    }
    return hit.value;
  }

  async get(key: string): Promise<string | null> {
    if (this.client) {
      try {
        return await this.client.get(key);
      } catch {
        /* 落回内存 */
      }
    }
    return this.memGet(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (this.client) {
      try {
        if (ttlSeconds && ttlSeconds > 0) await this.client.set(key, value, 'EX', ttlSeconds);
        else await this.client.set(key, value);
        return;
      } catch {
        /* 落回内存 */
      }
    }
    this.memory.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined,
    });
  }

  async del(key: string): Promise<void> {
    if (this.client) {
      try {
        await this.client.del(key);
      } catch {
        /* ignore */
      }
    }
    this.memory.delete(key);
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    if (this.client) {
      try {
        const n = await this.client.incr(key);
        if (ttlSeconds && n === 1) await this.client.expire(key, ttlSeconds);
        return n;
      } catch {
        /* 落回内存 */
      }
    }
    const current = Number.parseInt(this.memGet(key) ?? '0', 10) + 1;
    const existing = this.memory.get(key);
    this.memory.set(key, {
      value: String(current),
      expiresAt: existing?.expiresAt ?? (ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined),
    });
    return current;
  }

  async ttl(key: string): Promise<number> {
    if (this.client) {
      try {
        return await this.client.ttl(key);
      } catch {
        /* ignore */
      }
    }
    const hit = this.memory.get(key);
    if (!hit) return -2;
    if (!hit.expiresAt) return -1;
    return Math.max(0, Math.ceil((hit.expiresAt - Date.now()) / 1000));
  }

  /** 测试辅助：清空进程内存储 */
  clearMemory(): void {
    this.memory.clear();
  }
}
