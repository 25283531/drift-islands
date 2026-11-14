import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { Island } from '../database/entities/island.entities';
import { IslandRating } from '../database/entities/m4.entities';
import { IslandScoreInput, islandScore } from '../game/m4';
import { WorldService } from '../world/world.service';

export interface IslandScoreView {
  island_id: string;
  name: string;
  creator_user_id: string | null;
  visit_count: number;
  rating_count: number;
  avg_rating: number | null;
  resources_taken: number;
  days_since_visit: number;
  score: number;
}

/** §4.1 岛屿评分：访问量 35 + 评价 25 + 资源消耗 25 + 新鲜度 15 */
@Injectable()
export class RatingService {
  constructor(
    @InjectRepository(Island) private readonly islands: Repository<Island>,
    @InjectRepository(IslandRating) private readonly ratings: Repository<IslandRating>,
    private readonly world: WorldService,
  ) {}

  async rate(userId: string, islandId: string, score: number, comment?: string): Promise<IslandScoreView> {
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      throw new BadRequestException('评分必须是 1–5 的整数');
    }
    const island = await this.islands.findOne({ where: { id: islandId } });
    if (!island) throw new NotFoundException('岛屿不存在');
    const text = (comment ?? '').trim().slice(0, 200) || null;

    const existing = await this.ratings.findOne({ where: { island_id: islandId, user_id: userId } });
    if (existing) {
      existing.score = score;
      existing.comment = text;
      await this.ratings.save(existing);
    } else {
      await this.ratings.save(
        this.ratings.create({
          id: randomUUID(),
          island_id: islandId,
          user_id: userId,
          score,
          comment: text,
          created_at: new Date(),
        }),
      );
    }
    return this.summary(islandId);
  }

  async summary(islandId: string): Promise<IslandScoreView> {
    const island = await this.islands.findOne({ where: { id: islandId } });
    if (!island) throw new NotFoundException('岛屿不存在');
    const rows = await this.ratings.find({ where: { island_id: islandId } });
    const avg = rows.length > 0 ? rows.reduce((sum, row) => sum + row.score, 0) / rows.length : null;
    const state = await this.world.getState();
    const input: IslandScoreInput = {
      visitCount: island.visit_count ?? 0,
      avgRating: avg,
      ratingCount: rows.length,
      resourcesTaken: island.resources_taken ?? 0,
      daysSinceVisit: Math.max(0, state.world_day - (island.last_visit_world_day ?? state.world_day)),
    };
    return {
      island_id: island.id,
      name: island.name,
      creator_user_id: island.creator_user_id,
      visit_count: input.visitCount,
      rating_count: rows.length,
      avg_rating: avg == null ? null : Math.round(avg * 10) / 10,
      resources_taken: input.resourcesTaken,
      days_since_visit: input.daysSinceVisit,
      score: islandScore(input),
    };
  }

  async board(limit = 10): Promise<IslandScoreView[]> {
    const rows = await this.islands.find({ take: 100, order: { visit_count: 'DESC' } });
    const views: IslandScoreView[] = [];
    for (const island of rows) {
      views.push(await this.summary(island.id));
    }
    return views.sort((a, b) => b.score - a.score).slice(0, Math.min(Math.max(limit, 1), 50));
  }
}
