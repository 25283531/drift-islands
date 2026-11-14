import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { Channel } from '../database/entities/chat.entities';
import { Character } from '../database/entities/character.entities';
import { Island, Monster } from '../database/entities/island.entities';
import { ENCOUNTER_RANGE, PROTECTION } from '../game/constants';
import { bearingDeg, bearingText, distanceNm, round1 } from '../game/geo';

export interface EnterResult {
  island: Island;
  channel: Channel;
  monsters: Monster[];
  warnings: { type: string; text: string }[];
}

@Injectable()
export class IslandsService {
  constructor(
    @InjectRepository(Island) private readonly islands: Repository<Island>,
    @InjectRepository(Monster) private readonly monsters: Repository<Monster>,
    @InjectRepository(Channel) private readonly channels: Repository<Channel>,
  ) {}

  async get(islandId: string): Promise<Island | null> {
    return this.islands.findOne({ where: { id: islandId } });
  }

  async list(): Promise<Island[]> {
    return this.islands.find();
  }

  async aliveMonsters(islandId: string): Promise<Monster[]> {
    return this.monsters.find({
      where: { island_id: islandId, state: Not('dead') },
      order: { level: 'ASC' },
    });
  }

  encounterRange(isNight: boolean): number {
    return isNight ? ENCOUNTER_RANGE.NIGHT_NM : ENCOUNTER_RANGE.DAY_NM;
  }

  /** 遭遇范围内的最近岛屿（§4.1） */
  async findEncounter(x: number, y: number, isNight: boolean): Promise<Island | null> {
    const range = this.encounterRange(isNight);
    const all = await this.islands.find();
    let best: Island | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const island of all) {
      const d = distanceNm(x, y, island.x, island.y);
      if (d <= range && d < bestDistance) {
        best = island;
        bestDistance = d;
      }
    }
    return best;
  }

  async nearest(x: number, y: number, excludeId?: string): Promise<{ island: Island; distance: number } | null> {
    const all = await this.islands.find();
    let best: Island | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const island of all) {
      if (excludeId && island.id === excludeId) continue;
      const d = distanceNm(x, y, island.x, island.y);
      if (d < bestDistance) {
        best = island;
        bestDistance = d;
      }
    }
    return best ? { island: best, distance: bestDistance } : null;
  }

  /** 方向提示（不透露精确坐标，§3、§4.1） */
  directionHint(fromX: number, fromY: number, island: Island): string {
    const bearing = bearingDeg(fromX, fromY, island.x, island.y);
    const distance = distanceNm(fromX, fromY, island.x, island.y);
    return `方位${bearingText(bearing)}，距离约 ${round1(distance)} 海里`;
  }

  async channelOf(islandId: string): Promise<Channel | null> {
    return this.channels.findOne({ where: { island_id: islandId } });
  }

  async ensureChannel(island: Island): Promise<Channel> {
    const existing = await this.channels.findOne({ where: { island_id: island.id } });
    if (existing) return existing;
    return this.channels.save(
      this.channels.create({
        id: randomUUID(),
        type: 'island',
        island_id: island.id,
        name: island.name,
      }),
    );
  }

  /**
   * 进岛：必须已进入影响半径（与岛中心距离 ≤ 半径，§3）。
   * M1 返回岛上活着的怪物清单与保护期提示。
   */
  async enter(character: Character, islandId: string): Promise<EnterResult | { error: string }> {
    const island = await this.get(islandId);
    if (!island) return { error: '这座岛不存在' };
    if (character.island_id && character.island_id !== islandId) {
      return { error: '你已经在另一座岛上，先离岛' };
    }

    const distance = distanceNm(character.x, character.y, island.x, island.y);
    if (distance > island.radius) {
      return { error: `你还在岛外，距离${island.name}约 ${round1(distance)} 海里（影响半径 ${island.radius} 海里）` };
    }

    const channel = await this.ensureChannel(island);
    const monsters = await this.aliveMonsters(island.id);
    const warnings: { type: string; text: string }[] = [];

    // 保护期内主动进入高等级岛屿：允许，但提示存在高于自身 4 级的怪物 / 人物（§4.1）
    const highest = monsters.reduce((max, m) => Math.max(max, m.level), 0);
    if (highest > character.level + PROTECTION.ISLAND_WARNING_LEVEL_GAP) {
      warnings.push({
        type: 'high_level_island',
        text: `这座岛上有比你高 ${highest - character.level} 级的存在，超出了保护期的覆盖范围。`,
      });
    }

    const firstVisit = character.island_id !== islandId;
    if (firstVisit) {
      island.visit_count += 1;
      island.last_visit_world_day = island.last_visit_world_day;
      await this.islands.save(island);
    }

    character.island_id = island.id;
    return { island, channel, monsters, warnings };
  }

  async publicView(island: Island, viewer: Character) {
    const distance = distanceNm(viewer.x, viewer.y, island.x, island.y);
    const bearing = bearingDeg(viewer.x, viewer.y, island.x, island.y);
    const monsters = await this.aliveMonsters(island.id);
    const isCreator = island.creator_user_id && island.creator_user_id === viewer.user_id;
    const isOwner = island.owner_character_id === viewer.id;

    return {
      id: island.id,
      name: island.name,
      description: island.description,
      rules: island.rules,
      radius: island.radius,
      distance_nm: round1(distance),
      bearing_deg: Math.round(bearing),
      direction_text: bearingText(bearing),
      monster_count: monsters.length,
      max_monster_level: island.max_monster_level,
      visit_count: island.visit_count,
      // 创建者看不到坐标（§3 防自肥）；其他玩家也只给方向与距离，不返回精确坐标
      ...(isCreator || isOwner
        ? {
            owner_panel: {
              visit_count: island.visit_count,
              resources_taken: island.resources_taken,
              max_monster_level: island.max_monster_level,
              defense: island.defenses,
              firepower: monsters.reduce((sum, m) => sum + m.attack, 0),
            },
          }
        : {}),
    };
  }

  async nearby(x: number, y: number, radius: number) {
    const all = await this.islands.find();
    return all
      .map((island) => {
        const distance = distanceNm(x, y, island.x, island.y);
        const bearing = bearingDeg(x, y, island.x, island.y);
        return {
          id: island.id,
          name: island.name,
          distance_nm: round1(distance),
          direction_text: bearingText(bearing),
          bearing_deg: Math.round(bearing),
        };
      })
      .filter((row) => row.distance_nm <= radius)
      .sort((a, b) => a.distance_nm - b.distance_nm);
  }

  async nearestDirectionText(x: number, y: number): Promise<string> {
    const nearest = await this.nearest(x, y);
    if (!nearest) return '四周没有可辨认的岛影';
    return `${nearest.island.name}在${bearingText(bearingDeg(x, y, nearest.island.x, nearest.island.y))}方向约 ${round1(
      nearest.distance,
    )} 海里`;
  }
}
