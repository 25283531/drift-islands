import { BadRequestException, Body, Controller, Get, Injectable, Param, Post, Req, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Character, Ship } from '../database/entities/character.entities';
import { Item } from '../database/entities/item.entities';
import { CharactersService } from '../characters/characters.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SHIP_TRACK_MAX_LEVEL, ShipTrack, SHIP_TRACKS, upgradeCost, upgradeEffects } from '../game/m2';

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
export class ShipsService {
  constructor(
    @InjectRepository(Ship) private readonly ships: Repository<Ship>,
    @InjectRepository(Item) private readonly items: Repository<Item>,
    @InjectRepository(Character) private readonly characters: Repository<Character>,
    private readonly characterService: CharactersService,
  ) {}

  private levelOf(ship: Ship, track: ShipTrack): number {
    switch (track) {
      case 'defense':
        return ship.defense_lv;
      case 'weapon':
        return ship.weapon_lv;
      case 'living':
        return ship.living_lv;
      case 'research':
        return ship.research_lv;
      default:
        return 0;
    }
  }

  async view(character: Character) {
    const ship = await this.characterService.getShip(character.ship_id);
    if (!ship) return null;
    return {
      ship,
      tracks: SHIP_TRACKS.map((track) => ({
        track,
        level: this.levelOf(ship, track),
        max_level: SHIP_TRACK_MAX_LEVEL,
        next_cost: this.levelOf(ship, track) >= SHIP_TRACK_MAX_LEVEL ? null : upgradeCost(track, this.levelOf(ship, track)),
      })),
    };
  }

  /** §4.2 四条线：防御 / 武器 / 生活 / 科研 */
  async upgrade(character: Character, track: string): Promise<{ ship: Ship; spent: Record<string, number>; narration: string }> {
    if (!SHIP_TRACKS.includes(track as ShipTrack)) throw new BadRequestException('未知的升级线路');
    const typed = track as ShipTrack;
    const ship = await this.characterService.getShip(character.ship_id);
    if (!ship) throw new BadRequestException('你还没有船');
    const level = this.levelOf(ship, typed);
    if (level >= SHIP_TRACK_MAX_LEVEL) throw new BadRequestException('这条线已经升到顶了');

    const { needs } = upgradeCost(typed, level);
    const stacks = await this.items.find({
      where: { owner_type: 'character', owner_id: character.id, type: In(Object.keys(needs)) },
      order: { created_at: 'ASC' },
    });
    const available = new Map<string, number>();
    for (const stack of stacks) {
      available.set(stack.type, (available.get(stack.type) ?? 0) + stack.quantity);
    }
    const missing = Object.entries(needs).filter(([type, need]) => (available.get(type) ?? 0) < need);
    if (missing.length > 0) {
      const text = missing
        .map(([type, need]) => `${TYPE_LABEL[type] ?? type}×${need}（现有 ${available.get(type) ?? 0}）`)
        .join('、');
      throw new BadRequestException(`升级需要 ${text}`);
    }

    // 扣料
    const spent: Record<string, number> = {};
    for (const [type, need] of Object.entries(needs)) {
      let left = need;
      for (const stack of stacks.filter((row) => row.type === type)) {
        if (left <= 0) break;
        const take = Math.min(stack.quantity, left);
        stack.quantity -= take;
        left -= take;
        spent[type] = (spent[type] ?? 0) + take;
        if (stack.quantity === 0) {
          await this.items.remove(stack);
        } else {
          await this.items.save(stack);
        }
      }
    }

    const effects = upgradeEffects(typed, level + 1);
    if (effects.max_durability) {
      ship.max_durability += effects.max_durability;
      ship.durability = Math.min(ship.max_durability, ship.durability + effects.max_durability);
    }
    if (effects.weapon_power) ship.weapon_power += effects.weapon_power;
    if (effects.cargo_capacity) ship.cargo_capacity += effects.cargo_capacity;
    if (effects.max_stamina) {
      character.max_stamina += effects.max_stamina;
      character.stamina = Math.min(character.max_stamina, character.stamina + effects.max_stamina);
      await this.characterService.save(character);
    }
    if (typed === 'defense') ship.defense_lv = level + 1;
    if (typed === 'weapon') ship.weapon_lv = level + 1;
    if (typed === 'living') ship.living_lv = level + 1;
    if (typed === 'research') ship.research_lv = level + 1;
    await this.characterService.saveShip(ship);

    const label: Record<ShipTrack, string> = { defense: '船体与装甲', weapon: '火力', living: '生活设施', research: '科研设施' };
    return {
      ship,
      spent,
      narration: `你把材料摊在甲板上，敲敲打打半天，${label[typed]}升到了 ${level + 1} 级。`,
    };
  }
}

@Controller('api/v1/ships')
@UseGuards(JwtAuthGuard)
export class ShipsController {
  constructor(private readonly ships: ShipsService, private readonly characters: CharactersService) {}

  private async characterOf(req: any): Promise<Character> {
    const character = await this.characters.getForUser(req.user.sub);
    if (!character) throw new BadRequestException('请先创建角色');
    return character;
  }

  @Get('mine')
  async mine(@Req() req: any) {
    return this.ships.view(await this.characterOf(req));
  }

  @Post(':id/upgrade')
  async upgrade(@Req() req: any, @Param('id') id: string, @Body() body: { track?: string }) {
    const character = await this.characterOf(req);
    const ship = await this.characters.getShip(character.ship_id);
    if (!ship || ship.id !== id) throw new BadRequestException('这不是你的船');
    return this.ships.upgrade(character, body?.track ?? '');
  }
}
