import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { envInt } from '../common/env';
import { AiQuota } from '../database/entities/world.entities';
import { GAME } from '../game/constants';
import { KvService } from '../redis/kv.service';

export interface QuotaStatus {
  allowed: boolean;
  degraded: boolean;
  used: number;
  budget: number;
}

/**
 * 成本配额（§4.3、§1.22）：每玩家每日 AI 调用预算；
 * 超预算后 NarratorService 降级为模板叙述。
 */
@Injectable()
export class QuotaService {
  private readonly logger = new Logger(QuotaService.name);

  constructor(
    @InjectRepository(AiQuota) private readonly repo: Repository<AiQuota>,
    private readonly kv: KvService,
  ) {}

  get budget(): number {
    return envInt('AI_DAILY_BUDGET', GAME.AI_DAILY_BUDGET);
  }

  /** 现实日期按 Asia/Shanghai 计（世界日 8 现实小时，配额按自然日重置） */
  today(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  }

  async status(userId: string): Promise<QuotaStatus> {
    const date = this.today();
    const row = await this.repo.findOne({ where: { user_id: userId, real_date: date } });
    const used = row?.calls_used ?? 0;
    const budget = row?.budget ?? this.budget;
    const allowed = used < budget;
    return { allowed, degraded: !allowed, used, budget };
  }

  async check(userId: string): Promise<{ allowed: boolean; degraded: boolean }> {
    const status = await this.status(userId);
    return { allowed: status.allowed, degraded: status.degraded };
  }

  async record(userId: string, calls = 1): Promise<QuotaStatus> {
    const date = this.today();
    let row = await this.repo.findOne({ where: { user_id: userId, real_date: date } });
    if (!row) {
      row = this.repo.create({
        user_id: userId,
        real_date: date,
        calls_used: 0,
        budget: this.budget,
        degraded: false,
      });
    }
    row.calls_used += calls;
    row.degraded = row.calls_used >= row.budget;
    await this.repo.save(row);
    // Redis 计数与 ai_quotas 同步（§1.23）
    const ttl = 24 * 60 * 60;
    const key = `quota:${userId}:${date}`;
    const cached = Number.parseInt((await this.kv.get(key)) ?? '0', 10);
    if (cached < row.calls_used) await this.kv.set(key, String(row.calls_used), ttl);
    if (row.degraded) this.logger.warn(`用户 ${userId} 今日 AI 预算已用尽，叙述降级为模板`);
    return {
      allowed: row.calls_used < row.budget,
      degraded: row.calls_used >= row.budget,
      used: row.calls_used,
      budget: row.budget,
    };
  }
}
