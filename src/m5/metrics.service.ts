import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { AiQuota } from '../database/entities/world.entities';
import { Character } from '../database/entities/character.entities';
import { CombatSession } from '../database/entities/combat.entity';
import { Island } from '../database/entities/island.entities';
import { ModerationRecord } from '../database/entities/chat.entities';
import { Feedback } from '../database/entities/m5.entities';
import { Report } from '../database/entities/m4.entities';
import { KvService } from '../redis/kv.service';

/** §5.2 内测数据埋点：留存、在线、遭遇率、战斗完成率、AI 成本、违规量 */
@Injectable()
export class MetricsService {
  constructor(
    @InjectRepository(Character) private readonly characters: Repository<Character>,
    @InjectRepository(Island) private readonly islands: Repository<Island>,
    @InjectRepository(CombatSession) private readonly combats: Repository<CombatSession>,
    @InjectRepository(AiQuota) private readonly quotas: Repository<AiQuota>,
    @InjectRepository(ModerationRecord) private readonly moderation: Repository<ModerationRecord>,
    @InjectRepository(Report) private readonly reports: Repository<Report>,
    @InjectRepository(Feedback) private readonly feedback: Repository<Feedback>,
    private readonly kv: KvService,
  ) {}

  async snapshot() {
    const now = new Date();
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000);
    const date = now.toISOString().slice(0, 10);

    const [total, online, active24h, newToday, islands, combatTotal, combatFinished] = await Promise.all([
      this.characters.count(),
      this.characters.count({ where: { status: 'online' } }),
      this.characters.count({ where: { last_seen_at: MoreThanOrEqual(dayAgo) } }),
      this.characters.count({ where: { created_at: MoreThanOrEqual(dayStart) } }),
      this.islands.count(),
      this.combats.count(),
      this.combats.count({ where: { state: 'finished' } }),
    ]);

    const quotas = await this.quotas.find({ where: { real_date: date } });
    const aiCalls = quotas.reduce((sum, row) => sum + (row.calls_used ?? 0), 0);
    const degradedUsers = quotas.filter((row) => row.degraded).length;

    const violations = await this.moderation.find({ take: 1000, order: { created_at: 'DESC' } });
    const byAction = violations.reduce<Record<string, number>>((acc, row) => {
      acc[row.action] = (acc[row.action] ?? 0) + 1;
      return acc;
    }, {});

    const [pendingReports, newFeedback] = await Promise.all([
      this.reports.count({ where: { status: 'pending' } }),
      this.feedback.count({ where: { status: 'new' } }),
    ]);

    const travels = Number((await this.kv.get('metric:travel')) ?? 0);
    const encounters = Number((await this.kv.get('metric:encounter')) ?? 0);

    return {
      generated_at: now.toISOString(),
      players: {
        total,
        online,
        active_24h: active24h,
        new_today: newToday,
      },
      islands: { total: islands },
      combat: {
        total: combatTotal,
        finished: combatFinished,
        completion_rate: combatTotal > 0 ? Math.round((combatFinished / combatTotal) * 1000) / 1000 : null,
      },
      ai: {
        calls_today: aiCalls,
        degraded_users_today: degradedUsers,
        budget_per_user: quotas[0]?.budget ?? 200,
      },
      content: {
        violations_total: violations.length,
        by_action: byAction,
        pending_reports: pendingReports,
      },
      travel: {
        count: travels,
        encounters,
        encounter_rate: travels > 0 ? Math.round((encounters / travels) * 1000) / 1000 : null,
        note: '计数自本次部署起累计（Redis 内存计数）',
      },
      feedback: { new: newFeedback },
    };
  }

  /** §5.6 内容安全复核：红线拦截与处置分布 */
  async safetyReport(days = 7) {
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const records = await this.moderation.find({ where: { created_at: MoreThanOrEqual(since) }, take: 2000 });
    const byCategory = records.reduce<Record<string, number>>((acc, row) => {
      acc[row.category] = (acc[row.category] ?? 0) + 1;
      return acc;
    }, {});
    const byAction = records.reduce<Record<string, number>>((acc, row) => {
      acc[row.action] = (acc[row.action] ?? 0) + 1;
      return acc;
    }, {});
    const reports = await this.reports.find({ where: { created_at: MoreThanOrEqual(since) }, take: 1000 });
    return {
      window_days: days,
      generated_at: new Date().toISOString(),
      moderation_records: records.length,
      by_category: byCategory,
      by_action: byAction,
      reports: {
        total: reports.length,
        pending: reports.filter((row) => row.status === 'pending').length,
        dismissed: reports.filter((row) => row.status === 'dismissed').length,
        resolved: reports.filter((row) => row.status === 'resolved').length,
      },
      reviewed: records.filter((row) => row.reviewed_at).length,
    };
  }
}
