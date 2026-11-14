import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FeedbackService } from './feedback.service';

/** M5 内测：反馈入口 */
@Controller('api/v1')
@UseGuards(JwtAuthGuard)
export class M5Controller {
  constructor(private readonly feedback: FeedbackService) {}

  @Post('feedback')
  async submit(
    @Req() req: any,
    @Body() body: { category?: string; content?: string; character_id?: string },
  ) {
    const row = await this.feedback.create({
      userId: req.user.sub,
      characterId: body?.character_id ?? null,
      category: body?.category,
      content: body?.content ?? '',
    });
    return { feedback_id: row.id, status: row.status };
  }
}
