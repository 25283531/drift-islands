import { BadRequestException, Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { CharactersService } from '../characters/characters.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { IslandCreateService } from './island-create.service';
import { IslandDraft } from '../game/m2';

@Controller('api/v1/islands')
@UseGuards(JwtAuthGuard)
export class IslandCreateController {
  constructor(private readonly create: IslandCreateService, private readonly characters: CharactersService) {}

  private async characterOf(req: any) {
    const character = await this.characters.getForUser(req.user.sub);
    if (!character) throw new BadRequestException('请先创建角色');
    return character;
  }

  @Get('create/quota')
  async quota(@Req() req: any) {
    return this.create.quotaInfo(await this.characterOf(req));
  }

  /** 自由描述造岛（WS 模板流程同样落到 IslandCreateService.create） */
  @Post('create')
  async createIsland(@Req() req: any, @Body() body: Partial<IslandDraft>) {
    const character = await this.characterOf(req);
    const result = await this.create.create(character, body ?? {});
    // 只返回 id 与摘要，不返回坐标（§3）
    return { island_id: result.island.id, name: result.island.name, summary: result.summary };
  }
}
