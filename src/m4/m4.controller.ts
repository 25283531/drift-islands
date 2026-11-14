import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { IncentiveService } from './incentive.service';
import { RatingService } from './rating.service';
import { ReportService } from './report.service';

/** M4 对外接口：评分 / 榜单 / 举报 */
@Controller('api/v1')
@UseGuards(JwtAuthGuard)
export class M4Controller {
  constructor(
    private readonly rating: RatingService,
    private readonly incentive: IncentiveService,
    private readonly reports: ReportService,
  ) {}

  @Post('islands/:id/rate')
  async rate(
    @Req() req: any,
    @Param('id') islandId: string,
    @Body() body: { score?: number; comment?: string },
  ) {
    const score = Number(body?.score);
    return this.rating.rate(req.user.sub, islandId, score, body?.comment);
  }

  @Get('rankings/islands')
  async top(@Query('limit') limit?: string) {
    const n = Number(limit ?? 10);
    return { islands: await this.rating.board(Number.isFinite(n) ? n : 10) };
  }

  @Get('islands/:id/score')
  async score(@Param('id') islandId: string) {
    return this.rating.summary(islandId);
  }

  @Get('me/rewards')
  async myRewards(@Req() req: any) {
    return this.incentive.totalFor(req.user.sub);
  }

  @Post('reports')
  async report(
    @Req() req: any,
    @Body() body: { target_type?: string; target_id?: string; category?: string; detail?: string },
  ) {
    const report = await this.reports.create({
      reporterUserId: req.user.sub,
      targetType: body?.target_type ?? '',
      targetId: body?.target_id ?? '',
      category: body?.category ?? '',
      detail: body?.detail,
    });
    return { report_id: report.id, status: report.status };
  }
}

