import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { Island } from '../database/entities/island.entities';
import { CreatorReward } from '../database/entities/m4.entities';
import { rewardAmount } from '../game/m4';
import { WorldService } from '../world/world.service';
import { RatingService } from './rating.service';

/** §4.2 创作者激励：按岛屿评分分档发放，写入台账（岛 + 周期唯一，可审计） */
@Injectable()
export class IncentiveService {
  constructor(
    @InjectRepository(Island) private readonly islands: Repository<Island>,
    @InjectRepository(CreatorReward) private readonly rewards: Repository<CreatorReward>,
    private readonly rating: RatingService,
    private readonly world: WorldService,
  ) {}

  /** 结算指定世界日的激励；重复结算不会重复发放 */
  async settle(periodDay?: number, actor = 'gm') {
    const state = await this.world.getState();
    const day = Number.isInteger(periodDay) && periodDay! > 0 ? periodDay! : state.world_day;
    const list = await this.islands.find({ take: 200 });
    const granted: CreatorReward[] = [];
    const skipped: string[] = [];

    for (const island of list) {
      if (!island.creator_user_id) continue;
      const summary = await this.rating.summary(island.id);
      const amount = rewardAmount(summary.score);
      if (amount <= 0) {
        skipped.push(island.id);
        continue;
      }
      const exists = await this.rewards.findOne({ where: { island_id: island.id, period_day: day } });
      if (exists) {
        skipped.push(island.id);
        continue;
      }
      granted.push(
        await this.rewards.save(
          this.rewards.create({
            id: randomUUID(),
            island_id: island.id,
            creator_user_id: island.creator_user_id,
            period_day: day,
            score: summary.score,
            amount,
            reason: `世界日 ${day} 岛屿评分 ${summary.score}`,
            status: 'granted',
            settled_by: actor,
            created_at: new Date(),
          }),
        ),
      );
    }
    return {
      period_day: day,
      granted_count: granted.length,
      skipped_count: skipped.length,
      granted,
    };
  }

  async list(limit = 100): Promise<CreatorReward[]> {
    return this.rewards.find({ order: { created_at: 'DESC' }, take: Math.min(Math.max(limit, 1), 200) });
  }

  /** 某创作者的累计激励（审计/展示用） */
  async totalFor(creatorUserId: string): Promise<{ total: number; entries: number }> {
    const rows = await this.rewards.find({ where: { creator_user_id: creatorUserId, status: 'granted' } });
    return { total: rows.reduce((sum, row) => sum + row.amount, 0), entries: rows.length };
  }
}
