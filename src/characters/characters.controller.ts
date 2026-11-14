import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { CharactersService } from './characters.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('api/v1')
@UseGuards(JwtAuthGuard)
export class CharactersController {
  constructor(private readonly characters: CharactersService) {}

  @Get('me')
  async me(@Req() req: any) {
    const list = await this.characters.listByUser(req.user.sub);
    return {
      user_id: req.user.sub,
      display_name: req.user.name,
      characters: list,
    };
  }

  @Post('characters')
  async create(@Req() req: any, @Body() body: { name?: string; protection_level?: number }) {
    try {
      const { character, ship } = await this.characters.create(
        req.user.sub,
        body?.name ?? '',
        Number(body?.protection_level ?? 0),
      );
      return { character, ship };
    } catch (err) {
      return { error: { code: 'CREATE_CHARACTER_FAILED', message: (err as Error).message } };
    }
  }

  @Get('characters/:id')
  async detail(@Param('id') id: string) {
    const detail = await this.characters.detail(id);
    if (!detail) return { error: { code: 'NOT_FOUND', message: '角色不存在' } };
    return detail;
  }
}
