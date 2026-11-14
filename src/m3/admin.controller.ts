import {
  BadRequestException,
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  Injectable,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { ModerationRecord } from '../database/entities/chat.entities';
import { WorldEvent } from '../database/entities/world.entities';
import { Character } from '../database/entities/character.entities';
import { Island } from '../database/entities/island.entities';
import { envStr } from '../common/env';
import { ModelPoolService } from './model-pool.service';
import { IncentiveService } from '../m4/incentive.service';
import { ReportService } from '../m4/report.service';

/** GM 令牌校验：请求头 x-admin-token 与 ADMIN_TOKEN 一致 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = envStr('ADMIN_TOKEN', 'drift-admin-2026');
    const request = context.switchToHttp().getRequest();
    const token = request.headers['x-admin-token'] ?? '';
    if (!token || token !== expected) throw new ForbiddenException('GM 令牌无效');
    return true;
  }
}

@Controller('api/v1/admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    @InjectRepository(WorldEvent) private readonly events: Repository<WorldEvent>,
    @InjectRepository(ModerationRecord) private readonly moderation: Repository<ModerationRecord>,
    @InjectRepository(Character) private readonly characters: Repository<Character>,
    @InjectRepository(Island) private readonly islands: Repository<Island>,
    private readonly pool: ModelPoolService,
    private readonly reports: ReportService,
    private readonly incentives: IncentiveService,
  ) {}

  @Get('overview')
  async overview() {
    const [characters, islands, online, events, pending] = await Promise.all([
      this.characters.count(),
      this.islands.count(),
      this.characters.count({ where: { status: 'online' } }),
      this.events.count(),
      this.moderation.count({ where: { reviewed_at: null as any } }),
    ]);
    return { characters, islands, online, events, pending_reviews: pending, pending_reports: await this.reports.pendingCount() };
  }

  @Get('world-events')
  async listEvents(@Query('status') status?: string) {
    return this.events.find({
      where: status ? { status } : {},
      order: { created_at: 'DESC' },
      take: 50,
    });
  }

  @Post('world-events')
  async createEvent(
    @Body() body: { trigger_type?: string; trigger_value?: string; event_type?: string; payload?: any; created_by?: string },
  ) {
    if (!body?.event_type) throw new BadRequestException('event_type 必填');
    const event = await this.events.save(
      this.events.create({
        id: randomUUID(),
        trigger_type: body.trigger_type ?? 'real_time',
        trigger_value: body.trigger_value ?? '',
        event_type: body.event_type,
        payload: body.payload ?? {},
        status: 'pending',
        created_by: body.created_by ?? 'gm',
        created_at: new Date(),
      }),
    );
    return event;
  }

  @Patch('world-events/:id')
  async updateEvent(@Param('id') id: string, @Body() body: { status?: string }) {
    const event = await this.events.findOne({ where: { id } });
    if (!event) throw new BadRequestException('事件不存在');
    if (body?.status) event.status = body.status;
    return this.events.save(event);
  }

  @Get('model-pool')
  async modelPool() {
    return this.pool.list();
  }

  @Put('model-pool')
  async updateModelPool(@Body() body: { entries?: { id?: string; tier?: string; model_id?: string; priority?: number; enabled?: boolean }[] }) {
    return this.pool.update(body?.entries ?? []);
  }

  @Get('moderation')
  async listModeration(@Query('status') status?: string) {
    if (status === 'pending') {
      return this.moderation.find({ where: { reviewed_at: null as any }, order: { created_at: 'DESC' }, take: 50 });
    }
    return this.moderation.find({ order: { created_at: 'DESC' }, take: 50 });
  }

  @Post('moderation/:id/review')
  async review(@Param('id') id: string, @Body() body: { action?: string; reviewed_by?: string }) {
    const record = await this.moderation.findOne({ where: { id } });
    if (!record) throw new BadRequestException('审核记录不存在');
    record.action = body?.action ?? 'confirmed';
    record.reviewed_by = body?.reviewed_by ?? 'gm';
    record.reviewed_at = new Date();
    return this.moderation.save(record);
  }

  @Get('reports')
  async listReports(@Query('status') status?: string) {
    return this.reports.list(status);
  }

  @Post('reports/:id/resolve')
  async resolveReport(@Param('id') id: string, @Body() body: { action?: string; actor?: string }) {
    return this.reports.resolve(id, body?.action ?? '', body?.actor ?? 'gm');
  }

  @Get('rewards')
  async listRewards(@Query('limit') limit?: string) {
    const n = Number(limit ?? 100);
    return this.incentives.list(Number.isFinite(n) ? n : 100);
  }

  @Post('rewards/settle')
  async settleRewards(@Body() body: { period_day?: number; actor?: string }) {
    return this.incentives.settle(body?.period_day, body?.actor ?? 'gm');
  }
}
