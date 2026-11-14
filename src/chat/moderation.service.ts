import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { ModerationRecord } from '../database/entities/chat.entities';
import { User } from '../database/entities/user.entity';
import { ContentFilterService } from '../ai/content-filter.service';
import { KvService } from '../redis/kv.service';
import { GAME, RedlineCategory } from '../game/constants';

export interface ViolationOutcome {
  action: 'warn' | 'mute' | 'ban';
  category: RedlineCategory;
  categoryName: string;
  muteSeconds?: number;
  banned?: boolean;
  count: number;
}

/**
 * 内容治理（§4.4）：第 1 次提示 + 隔离，第 2 次禁言 1 世界日，第 3 次起封禁（人工复核）。
 */
@Injectable()
export class ModerationService {
  constructor(
    @InjectRepository(ModerationRecord) private readonly records: Repository<ModerationRecord>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly filter: ContentFilterService,
    private readonly kv: KvService,
  ) {}

  classify(text: string) {
    return this.filter.classify(text);
  }

  get muteSeconds(): number {
    // 1 世界日 = 8 现实小时
    return (GAME.REAL_MINUTES_PER_WORLD_DAY * 60);
  }

  async isMuted(userId: string): Promise<boolean> {
    const ttl = await this.kv.ttl(`mute:${userId}`);
    return ttl > 0;
  }

  async muteRemaining(userId: string): Promise<number> {
    return Math.max(0, await this.kv.ttl(`mute:${userId}`));
  }

  async recordViolation(params: {
    userId: string;
    characterId: string | null;
    channelId: string;
    messageId: string | null;
    category: RedlineCategory;
  }): Promise<ViolationOutcome> {
    const previous = await this.records.count({ where: { user_id: params.userId } });
    const count = previous + 1;

    let action: ViolationOutcome['action'] = 'warn';
    if (count === 2) action = 'mute';
    else if (count >= 3) action = 'ban';

    await this.records.save(
      this.records.create({
        id: randomUUID(),
        user_id: params.userId,
        character_id: params.characterId,
        channel_id: params.channelId,
        message_id: params.messageId,
        category: params.category,
        action: action === 'warn' ? 'quarantine' : action,
        created_at: new Date(),
        reviewed_by: null,
        reviewed_at: null,
      }),
    );

    const user = await this.users.findOne({ where: { id: params.userId } });
    let outcome: ViolationOutcome = {
      action,
      category: params.category,
      categoryName: this.filter.categoryName(params.category),
      count,
    };

    if (user) {
      if (action === 'mute') {
        user.status = 'muted';
        await this.users.save(user);
        await this.kv.set(`mute:${params.userId}`, '1', this.muteSeconds);
        outcome = { ...outcome, muteSeconds: this.muteSeconds };
      } else if (action === 'ban') {
        user.status = 'banned';
        await this.users.save(user);
        outcome = { ...outcome, banned: true };
      }
    }
    return outcome;
  }

  async listRecords(limit = 100): Promise<ModerationRecord[]> {
    return this.records.find({ order: { created_at: 'DESC' }, take: limit });
  }

  /** 人工复核后的处置（举报闭环）：提示 / 禁言 1 世界日 / 封禁 */
  async applyManual(userId: string, action: 'warn' | 'mute' | 'ban', actor = 'gm'): Promise<{ action: string; status: string }> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new Error('被举报账号不存在');

    if (action === 'mute') {
      user.status = 'muted';
      await this.users.save(user);
      await this.kv.set(`mute:${userId}`, '1', this.muteSeconds);
    } else if (action === 'ban') {
      user.status = 'banned';
      await this.users.save(user);
    }

    await this.records.save(
      this.records.create({
        id: randomUUID(),
        user_id: userId,
        character_id: null,
        channel_id: null as any,
        message_id: null,
        category: 'manual' as any,
        action,
        created_at: new Date(),
        reviewed_by: actor,
        reviewed_at: new Date(),
      }),
    );
    return { action, status: user.status };
  }
}
