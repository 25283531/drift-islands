import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { Feedback } from '../database/entities/m5.entities';

const CATEGORIES = ['bug', 'suggestion', 'balance', 'other'];

/** §5.3 内测问题收集：反馈入库，后台可查、可关闭 */
@Injectable()
export class FeedbackService {
  constructor(@InjectRepository(Feedback) private readonly repo: Repository<Feedback>) {}

  async create(params: {
    userId: string;
    characterId?: string | null;
    category?: string;
    content: string;
  }): Promise<Feedback> {
    const content = (params.content ?? '').trim();
    if (content.length < 2) throw new BadRequestException('反馈内容太短');
    if (content.length > 1000) throw new BadRequestException('反馈最多 1000 字');
    const category = CATEGORIES.includes(params.category ?? '') ? params.category! : 'other';
    return this.repo.save(
      this.repo.create({
        id: randomUUID(),
        user_id: params.userId,
        character_id: params.characterId ?? null,
        category,
        content,
        status: 'new',
        handled_by: null,
        handled_at: null,
        created_at: new Date(),
      }),
    );
  }

  async list(status?: string, limit = 50): Promise<Feedback[]> {
    return this.repo.find({
      where: status ? { status } : {},
      order: { created_at: 'DESC' },
      take: Math.min(Math.max(limit, 1), 200),
    });
  }

  async close(id: string, actor = 'gm'): Promise<Feedback> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('反馈不存在');
    row.status = 'closed';
    row.handled_by = actor;
    row.handled_at = new Date();
    return this.repo.save(row);
  }

  async pendingCount(): Promise<number> {
    return this.repo.count({ where: { status: 'new' } });
  }
}
