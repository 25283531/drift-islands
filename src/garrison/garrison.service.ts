import { BadRequestException, Body, Controller, Get, Injectable, Param, Post, Req, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Character } from '../database/entities/character.entities';
import { Island } from '../database/entities/island.entities';
import { Item } from '../database/entities/item.entities';
import { CharactersService } from '../characters/characters.service';
import { IslandsService } from '../islands/islands.service';
import { IslandCreateService } from '../islands/island-create.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { randomUUID } from 'crypto';
import { In } from 'typeorm';

export type BaseFacility = 'defense' | 'storage' | 'facility';
const FACILITY_MAX = 3;

const BUILD_COST: Record<BaseFacility, Record<string, number>> = {
  defense: { part: 4, tech: 2 },
  storage: { part: 3, tech: 1 },
  facility: { tech: 2, food: 2 },
};

const TYPE_LABEL: Record<string, string> = {
  fuel: '燃料',
  food: '食物',
  water: '淡水',
  medicine: '药品',
  part: '零件',
  weapon: '武器',
  tech: '科技件',
  misc: '杂物',
};

@Injectable()
export class GarrisonService {
  constructor(
    @InjectRepository(Island) private readonly islands: Repository<Island>,
    @InjectRepository(Item) private readonly items: Repository<Item>,
    private readonly characters: CharactersService,
    private readonly islandService: IslandsService,
    private readonly islandCreate: IslandCreateService,
  ) {}

  /** 驻扎：成为岛主（§4.2）；已有岛主时需先夺岛（M3） */
  async settle(character: Character, islandId: string) {
    const island = await this.islands.findOne({ where: { id: islandId } });
    if (!island) throw new BadRequestException('这座岛不存在');
    if (character.island_id !== islandId) throw new BadRequestException('你必须先上岛');
    if (island.owner_character_id && island.owner_character_id !== character.id) {
      throw new BadRequestException('这座岛已经有主了，夺岛要等 M3 的 PvP 流程');
    }
    island.owner_character_id = character.id;
    const raw = island.buildings as any;
    const buildings = Array.isArray(raw) ? { list: raw } : raw ?? {};
    if (!buildings.base) {
      buildings.base = { defense_lv: 1, storage_lv: 1, facility_lv: 1 };
    }
    island.buildings = buildings;
    await this.islands.save(island);
    return {
      ok: true,
      island_id: island.id,
      name: island.name,
      base: buildings.base,
      narration: `你在${island.name}的背风处钉下第一根桩子。从现在起，这座岛归你守。`,
    };
  }

  async build(character: Character, islandId: string, facility: string) {
    if (!['defense', 'storage', 'facility'].includes(facility)) throw new BadRequestException('未知的设施');
    const typed = facility as BaseFacility;
    const island = await this.islands.findOne({ where: { id: islandId } });
    if (!island) throw new BadRequestException('这座岛不存在');
    if (island.owner_character_id !== character.id) throw new BadRequestException('只有岛主能建设基地');
    const buildings = Array.isArray(island.buildings) ? { list: island.buildings } : (island.buildings as any) ?? {};
    const base = buildings.base ?? { defense_lv: 1, storage_lv: 1, facility_lv: 1 };
    const key = `${typed}_lv` as 'defense_lv' | 'storage_lv' | 'facility_lv';
    if ((base[key] ?? 0) >= FACILITY_MAX) throw new BadRequestException('这项设施已经升到顶了');

    const needs = BUILD_COST[typed];
    await this.consume(character.id, needs);

    base[key] = (base[key] ?? 0) + 1;
    buildings.base = base;
    island.buildings = buildings;
    await this.islands.save(island);
    return {
      ok: true,
      base,
      narration: `你带着人把${typed === 'defense' ? '防御墙' : typed === 'storage' ? '储物棚' : '修理台'}又加高了一层。`,
    };
  }

  /** 基地储物：把背包里的成组资源存进岛上（岛主专用） */
  async store(character: Character, islandId: string, type: string, quantity: number) {
    const island = await this.requireOwner(character, islandId);
    const amount = Math.max(1, Math.floor(Number(quantity) || 1));
    const stacks = await this.items.find({
      where: { owner_type: 'character', owner_id: character.id, type },
      order: { created_at: 'ASC' },
    });
    const total = stacks.reduce((sum, stack) => sum + stack.quantity, 0);
    if (total < amount) throw new BadRequestException(`背包里只有 ${total} 份${TYPE_LABEL[type] ?? type}`);

    let left = amount;
    for (const stack of stacks) {
      if (left <= 0) break;
      const take = Math.min(stack.quantity, left);
      stack.quantity -= take;
      left -= take;
      if (stack.quantity === 0) await this.items.remove(stack);
      else await this.items.save(stack);
    }
    let stored = await this.items.findOne({
      where: { owner_type: 'island', owner_id: island.id, name: TYPE_LABEL[type] ?? type, type },
    });
    if (!stored) {
      stored = this.items.create({
        id: randomUUID(),
        name: TYPE_LABEL[type] ?? type,
        type,
        tags: ['storage'],
        quantity: amount,
        condition: null,
        owner_type: 'island',
        owner_id: island.id,
        x: island.x,
        y: island.y,
      });
    } else {
      stored.quantity += amount;
      stored.tags = Array.from(new Set([...(Array.isArray(stored.tags) ? stored.tags : []), 'storage']));
    }
    await this.items.save(stored);
    return { ok: true, stored: amount, type };
  }

  async take(character: Character, islandId: string, type: string, quantity: number) {
    const island = await this.requireOwner(character, islandId);
    const amount = Math.max(1, Math.floor(Number(quantity) || 1));
    const stored = await this.items.findOne({
      where: { owner_type: 'island', owner_id: island.id, type, quantity: In([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) },
    });
    const stacks = await this.items.find({ where: { owner_type: 'island', owner_id: island.id, type } });
    const total = stacks.reduce((sum, stack) => sum + stack.quantity, 0);
    if (total < amount) throw new BadRequestException(`岛上只存了 ${total} 份`);

    let left = amount;
    for (const stack of stacks) {
      if (left <= 0) break;
      const take = Math.min(stack.quantity, left);
      stack.quantity -= take;
      left -= take;
      if (stack.quantity === 0) await this.items.remove(stack);
      else await this.items.save(stack);
    }
    let carried = await this.items.findOne({ where: { owner_type: 'character', owner_id: character.id, type } });
    if (!carried) {
      carried = this.items.create({
        id: randomUUID(),
        name: stored?.name ?? TYPE_LABEL[type] ?? type,
        type,
        tags: null,
        quantity: amount,
        condition: null,
        owner_type: 'character',
        owner_id: character.id,
        x: character.x,
        y: character.y,
      });
    } else {
      carried.quantity += amount;
    }
    await this.items.save(carried);
    return { ok: true, taken: amount, type };
  }

  async storage(islandId: string) {
    const rows = await this.items.find({ where: { owner_type: 'island', owner_id: islandId } });
    return rows
      .filter((row) => Array.isArray(row.tags) && row.tags.includes('storage'))
      .map((row) => ({ id: row.id, name: row.name, type: row.type, quantity: row.quantity }));
  }

  async panel(character: Character, islandId: string) {
    const panel = await this.islandCreate.panel(islandId, character);
    if (!panel) throw new BadRequestException('只有岛主或创建者能看这块面板');
    return { ...panel, storage: await this.storage(islandId) };
  }

  private async requireOwner(character: Character, islandId: string): Promise<Island> {
    const island = await this.islands.findOne({ where: { id: islandId } });
    if (!island) throw new BadRequestException('这座岛不存在');
    if (island.owner_character_id !== character.id) throw new BadRequestException('只有岛主能操作基地储物');
    return island;
  }

  private async consume(characterId: string, needs: Record<string, number>): Promise<void> {
    const stacks = await this.items.find({
      where: { owner_type: 'character', owner_id: characterId, type: In(Object.keys(needs)) },
      order: { created_at: 'ASC' },
    });
    const available = new Map<string, number>();
    for (const stack of stacks) available.set(stack.type, (available.get(stack.type) ?? 0) + stack.quantity);
    const missing = Object.entries(needs).filter(([type, need]) => (available.get(type) ?? 0) < need);
    if (missing.length > 0) {
      throw new BadRequestException(
        `材料不够：${missing.map(([type, need]) => `${TYPE_LABEL[type] ?? type}×${need}（现有 ${available.get(type) ?? 0}）`).join('、')}`,
      );
    }
    for (const [type, need] of Object.entries(needs)) {
      let left = need;
      for (const stack of stacks.filter((row) => row.type === type)) {
        if (left <= 0) break;
        const take = Math.min(stack.quantity, left);
        stack.quantity -= take;
        left -= take;
        if (stack.quantity === 0) await this.items.remove(stack);
        else await this.items.save(stack);
      }
    }
  }
}

@Controller('api/v1/islands')
@UseGuards(JwtAuthGuard)
export class GarrisonController {
  constructor(
    private readonly garrison: GarrisonService,
    private readonly characters: CharactersService,
    private readonly islands: IslandsService,
  ) {}

  private async characterOf(req: any): Promise<Character> {
    const character = await this.characters.getForUser(req.user.sub);
    if (!character) throw new BadRequestException('请先创建角色');
    return character;
  }

  @Post(':id/settle')
  async settle(@Req() req: any, @Param('id') id: string) {
    return this.garrison.settle(await this.characterOf(req), id);
  }

  @Post(':id/build')
  async build(@Req() req: any, @Param('id') id: string, @Body() body: { facility?: string }) {
    return this.garrison.build(await this.characterOf(req), id, body?.facility ?? '');
  }

  @Post(':id/store')
  async store(@Req() req: any, @Param('id') id: string, @Body() body: { type?: string; quantity?: number }) {
    return this.garrison.store(await this.characterOf(req), id, body?.type ?? '', Number(body?.quantity ?? 1));
  }

  @Post(':id/take')
  async take(@Req() req: any, @Param('id') id: string, @Body() body: { type?: string; quantity?: number }) {
    return this.garrison.take(await this.characterOf(req), id, body?.type ?? '', Number(body?.quantity ?? 1));
  }

  @Get(':id/panel')
  async panel(@Req() req: any, @Param('id') id: string) {
    return this.garrison.panel(await this.characterOf(req), id);
  }
}
