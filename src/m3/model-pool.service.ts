import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ModelPool } from '../database/entities/world.entities';
import { envStr } from '../common/env';

const COOLDOWN_MS = 60 * 1000;

/**
 * 模型池（§4.3、3.10）：数据库配置，同优先级随机，失败冷却，优先级升序。
 * 启动时若表为空，用环境变量播种，保证与 .env 的模型列表一致。
 */
@Injectable()
export class ModelPoolService implements OnModuleInit {
  private readonly logger = new Logger(ModelPoolService.name);

  constructor(@InjectRepository(ModelPool) private readonly repo: Repository<ModelPool>) {}

  async onModuleInit(): Promise<void> {
    const count = await this.repo.count();
    if (count > 0) return;
    const rows: Partial<ModelPool>[] = [];
    const providers: { name: string; raw: string }[] = [
      { name: 'openrouter', raw: envStr('OPENROUTER_MODELS', '') },
      { name: 'nvidia', raw: envStr('NVIDIA_MODELS', '') },
    ];
    for (const provider of providers) {
      const entries = provider.raw
        .split(/[,;\n]/)
        .map((item) => item.trim())
        .filter(Boolean);
      entries.forEach((entry, index) => {
        const match = /^(small|large)\s*:\s*(.+)$/i.exec(entry);
        const tier = match ? match[1].toLowerCase() : 'small';
        const model = match ? match[2].trim() : entry;
        rows.push({
          id: `${provider.name}:${model}:${tier}`,
          tier,
          model_id: `${provider.name}:${model}`,
          priority: index,
          enabled: true,
          failure_count: 0,
          last_failure_at: null,
        });
      });
    }
    if (rows.length === 0) return;
    await this.repo.save(rows.map((row) => this.repo.create(row)));
    this.logger.log(`模型池已播种 ${rows.length} 条`);
  }

  async list(): Promise<ModelPool[]> {
    return this.repo.find({ order: { tier: 'ASC', priority: 'ASC' } });
  }

  /** 同优先级随机；跳过禁用与冷却中的模型 */
  async select(tier: 'small' | 'large'): Promise<ModelPool | null> {
    const rows = (await this.repo.find({ where: { tier, enabled: true } })).filter(
      (row) => !row.last_failure_at || Date.now() - new Date(row.last_failure_at).getTime() > COOLDOWN_MS,
    );
    if (rows.length === 0) return null;
    const best = Math.min(...rows.map((row) => row.priority));
    const group = rows.filter((row) => row.priority === best);
    return group[Math.floor(Math.random() * group.length)];
  }

  async reportFailure(id: string): Promise<void> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) return;
    row.failure_count += 1;
    row.last_failure_at = new Date();
    await this.repo.save(row);
  }

  async update(entries: { id?: string; tier?: string; model_id?: string; priority?: number; enabled?: boolean }[]): Promise<ModelPool[]> {
    for (const entry of entries) {
      if (!entry.id) continue;
      const existing = await this.repo.findOne({ where: { id: entry.id } });
      if (existing) {
        if (typeof entry.priority === 'number') existing.priority = entry.priority;
        if (typeof entry.enabled === 'boolean') existing.enabled = entry.enabled;
        await this.repo.save(existing);
      } else if (entry.model_id && (entry.tier === 'small' || entry.tier === 'large')) {
        await this.repo.save(
          this.repo.create({
            id: entry.id,
            tier: entry.tier,
            model_id: entry.model_id,
            priority: entry.priority ?? 100,
            enabled: entry.enabled ?? true,
            failure_count: 0,
            last_failure_at: null,
          }),
        );
      }
    }
    return this.list();
  }
}
