import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CharactersService } from '../characters/characters.service';
import { IslandsService } from './islands.service';

@Controller('api/v1/islands')
@UseGuards(JwtAuthGuard)
export class IslandsController {
  constructor(
    private readonly islands: IslandsService,
    private readonly characters: CharactersService,
  ) {}

  /** GET /api/v1/islands/nearby?x&y&r —— 只返回方向与距离（不透露精确坐标） */
  @Get('nearby')
  async nearby(@Query('x') x: string, @Query('y') y: string, @Query('r') r: string) {
    const px = Number.parseFloat(x);
    const py = Number.parseFloat(y);
    const radius = Number.parseFloat(r ?? '50');
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
      return { error: { code: 'BAD_COORDINATE', message: '缺少有效坐标 x / y' } };
    }
    return { islands: await this.islands.nearby(px, py, Number.isFinite(radius) ? radius : 50) };
  }

  @Get(':id')
  async detail(@Req() req: any, @Param('id') id: string, @Query('character_id') characterId?: string) {
    const island = await this.islands.get(id);
    if (!island) return { error: { code: 'NOT_FOUND', message: '岛屿不存在' } };
    const character = characterId
      ? await this.characters.get(characterId)
      : await this.characters.getForUser(req.user.sub);
    if (!character || character.user_id !== req.user.sub) {
      return { error: { code: 'NO_CHARACTER', message: '请先创建角色' } };
    }
    return this.islands.publicView(island, character);
  }
}
