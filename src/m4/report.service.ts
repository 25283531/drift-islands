import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { Character } from '../database/entities/character.entities';
import { ChatMessage } from '../database/entities/chat.entities';
import { Island } from '../database/entities/island.entities';
import { Report } from '../database/entities/m4.entities';
import { ModerationService } from '../chat/moderation.service';
import { ReportAction, isReportAction } from '../game/m4';

const TARGET_TYPES = ['chat_message', 'island', 'character'];
const CATEGORIES = ['redline', 'harassment', 'cheat', 'bad_island', 'other'];

/** §4.3 内容治理：举报 → 审核 → 处置（提示 / 禁言 / 封禁） */
@Injectable()
export class ReportService {
  constructor(
    @InjectRepository(Report) private readonly reports: Repository<Report>,
    @InjectRepository(ChatMessage) private readonly messages: Repository<ChatMessage>,
    @InjectRepository(Character) private readonly characters: Repository<Character>,
    @InjectRepository(Island) private readonly islands: Repository<Island>,
    private readonly moderation: ModerationService,
  ) {}

  async create(params: {
    reporterUserId: string;
    targetType: string;
    targetId: string;
    category: string;
    detail?: string;
  }): Promise<Report> {
    const targetType = (params.targetType ?? '').trim();
    const category = (params.category ?? '').trim();
    if (!TARGET_TYPES.includes(targetType)) throw new BadRequestException('target_type 不合法');
    if (!CATEGORIES.includes(category)) throw new BadRequestException('举报类别不合法');
    if (!params.targetId) throw new BadRequestException('缺少 target_id');

    await this.authorOf(targetType, params.targetId); // 目标不存在直接 404
    const exists = await this.reports.findOne({
      where: {
        reporter_user_id: params.reporterUserId,
        target_type: targetType,
        target_id: params.targetId,
        status: 'pending',
      },
    });
    if (exists) return exists;

    return this.reports.save(
      this.reports.create({
        id: randomUUID(),
        reporter_user_id: params.reporterUserId,
        target_type: targetType,
        target_id: params.targetId,
        category,
        detail: (params.detail ?? '').trim().slice(0, 500) || null,
        status: 'pending',
        action: null,
        handled_by: null,
        handled_at: null,
        created_at: new Date(),
      }),
    );
  }

  async list(status?: string, limit = 50): Promise<Report[]> {
    return this.reports.find({
      where: status ? { status } : {},
      order: { created_at: 'DESC' },
      take: Math.min(Math.max(limit, 1), 200),
    });
  }

  async pendingCount(): Promise<number> {
    return this.reports.count({ where: { status: 'pending' } });
  }

  /** 处置举报：dismiss / warn / mute / ban，并记录处置人 */
  async resolve(reportId: string, action: string, actor = 'gm') {
    if (!isReportAction(action)) throw new BadRequestException('处置动作不合法');
    const report = await this.reports.findOne({ where: { id: reportId } });
    if (!report) throw new NotFoundException('举报不存在');
    if (report.status !== 'pending') throw new BadRequestException('这条举报已经处理过了');

    const author = await this.authorOf(report.target_type, report.target_id);
    let outcome: { action: string; status: string } | null = null;
    if (action !== 'dismiss') {
      outcome = await this.moderation.applyManual(author.userId, action as Exclude<ReportAction, 'dismiss'>, actor);
    }

    report.status = action === 'dismiss' ? 'dismissed' : 'resolved';
    report.action = action;
    report.handled_by = actor;
    report.handled_at = new Date();
    await this.reports.save(report);
    return { report, target_user_id: author.userId, outcome };
  }

  /** 举报对象的作者/责任人 */
  private async authorOf(targetType: string, targetId: string): Promise<{ userId: string }> {
    if (targetType === 'chat_message') {
      const message = await this.messages.findOne({ where: { id: targetId } });
      if (!message) throw new NotFoundException('被举报的发言不存在');
      if (!message.sender_character_id) throw new BadRequestException('系统消息不能被举报');
      const character = await this.characters.findOne({ where: { id: message.sender_character_id } });
      if (!character) throw new NotFoundException('发言角色不存在');
      return { userId: character.user_id };
    }
    if (targetType === 'character') {
      const character = await this.characters.findOne({ where: { id: targetId } });
      if (!character) throw new NotFoundException('角色不存在');
      return { userId: character.user_id };
    }
    const island = await this.islands.findOne({ where: { id: targetId } });
    if (!island) throw new NotFoundException('岛屿不存在');
    if (!island.creator_user_id) throw new BadRequestException('这座岛没有创作者可追责');
    return { userId: island.creator_user_id };
  }
}
