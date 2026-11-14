import { Injectable, Logger } from '@nestjs/common';
import { Character, Ship } from '../database/entities/character.entities';
import { Island } from '../database/entities/island.entities';
import { NarratorService } from '../ai/narrator.service';
import { WorldService, WorldTimeInfo } from '../world/world.service';
import { IslandsService } from '../islands/islands.service';
import { CharactersService } from '../characters/characters.service';
import { KvService } from '../redis/kv.service';
import { GAME } from '../game/constants';
import { bearingDeg, bearingText, distanceNm, normalizeAngle, round1 } from '../game/geo';
import { planMove } from './movement.plan';
import { crewFuelMultiplier } from '../game/m3';

export interface TravelResult {
  character: Character;
  ship: Ship;
  from: { x: number; y: number };
  to: { x: number; y: number };
  distance: number;
  hours: number;
  fuelUsed: number;
  along_current: boolean;
  time: WorldTimeInfo;
  narration: { text: string; source: string; degraded: boolean };
  encounter?: { island: Island; distance: number; hint: string };
  encounter_narration?: { text: string; source: string; degraded: boolean };
  warnings: { type: string; text: string }[];
  refused?: string;
}

const SCENERY = [
  '只剩一层灰白的浪',
  '浮着一圈油膜',
  '有半截集装箱随浪起伏',
  '远处传来金属碰撞的回声',
  '雾贴着水面走',
  '一群海鸟跟着船尾',
  '浪里翻出几片碎木板',
];

@Injectable()
export class MovementService {
  private readonly logger = new Logger(MovementService.name);
  constructor(
    private readonly characters: CharactersService,
    private readonly world: WorldService,
    private readonly islands: IslandsService,
    private readonly narrator: NarratorService,
    private readonly kv: KvService,
  ) {}

  async move(characterId: string, angle: number, distance: number): Promise<TravelResult> {
    const character = await this.characters.get(characterId);
    if (!character) throw new Error('角色不存在');
    const ship = await this.characters.getShip(character.ship_id);
    if (!ship) throw new Error('你还没有船');

    const guard = this.guardSail(character);
    if (guard) return this.refuse(character, ship, guard);

    const safeAngle = normalizeAngle(Number.isFinite(angle) ? angle : 0);
    const safeDistance = Number.isFinite(distance) ? distance : 0;
    if (safeDistance <= 0) {
      return this.refuse(character, ship, '航程必须大于 0 海里');
    }

    const state = await this.world.getState();
    const plan = planMove({
      x: character.x,
      y: character.y,
      angle: safeAngle,
      distance: safeDistance,
      shipSpeed: ship.speed,
      fuel: ship.fuel,
      currentDirection: state.current_direction,
      seaRadius: state.sea_radius_nm,
    });

    return this.finalize(character, ship, plan, 'sail');
  }

  async drift(characterId: string): Promise<TravelResult> {
    const character = await this.characters.get(characterId);
    if (!character) throw new Error('角色不存在');
    const ship = await this.characters.getShip(character.ship_id);
    if (!ship) throw new Error('你还没有船');

    const guard = this.guardSail(character);
    if (guard) return this.refuse(character, ship, guard);

    const state = await this.world.getState();
    // 随机漂流 1 世界小时；漂流不烧油（随浪走，§4.1）
    // 靠近边界时把方向掰回海域中心，避免顶着边界漂流 0 距离、时间也不推进
    let angle = Math.random() * 360;
    const fromCenter = Math.hypot(character.x, character.y);
    if (fromCenter > state.sea_radius_nm * 0.8) {
      const inward = (Math.atan2(-character.y, -character.x) * 180) / Math.PI;
      angle = (inward + (Math.random() * 60 - 30) + 360) % 360;
    }
    const distance = ship.speed;
    const plan = planMove({
      x: character.x,
      y: character.y,
      angle,
      distance,
      shipSpeed: ship.speed,
      fuel: ship.fuel,
      currentDirection: state.current_direction,
      seaRadius: state.sea_radius_nm,
    });
    plan.fuelUsed = 0;
    // 即使被边界截断，漂流也消耗 1 世界小时，保证遭遇保底计时能推进
    if (plan.hours < 0.5) plan.hours = 1;

    const result = await this.finalize(character, ship, plan, 'drift');
    return result;
  }

  private guardSail(character: Character): string | null {
    if (character.island_id) return '你还在岛上，先离岛再启航';
    if (character.status === 'in_combat') return '战斗中不能开船';
    if (character.status === 'dead') return '你已经死了，等待复活';
    return null;
  }

  private refuse(character: Character, ship: Ship, message: string): TravelResult {
    return {
      character,
      ship,
      from: { x: character.x, y: character.y },
      to: { x: character.x, y: character.y },
      distance: 0,
      hours: 0,
      fuelUsed: 0,
      along_current: false,
      time: { world_day: 0, world_minutes: 0, world_hour: 0, day_night: 'day', text: '' },
      narration: { text: message, source: 'template', degraded: false },
      warnings: [],
      refused: message,
    };
  }

  private async finalize(
    character: Character,
    ship: Ship,
    plan: { x: number; y: number; distance: number; hours: number; fuelUsed: number; alongCurrent: boolean; warnings: { type: string; text: string }[]; bearing: number },
    mode: 'sail' | 'drift',
  ): Promise<TravelResult> {
    const from = { x: character.x, y: character.y };
    const warnings = [...plan.warnings];

    // 消耗按船上实际人数计算（§3）：同船的人一起分担，但油耗按人头叠加
    const crew = mode === 'sail' ? await this.characters.countCrew(ship.id) : 1;
    if (mode === 'sail' && crew > 1) {
      plan.fuelUsed = Math.min(ship.fuel, round1(plan.fuelUsed * crewFuelMultiplier(crew)));
      warnings.push({ type: 'crew', text: `船上共 ${crew} 人，燃料按人数计算。` });
    }

    character.x = plan.x;
    character.y = plan.y;
    ship.x = plan.x;
    ship.y = plan.y;
    ship.fuel = Math.max(0, ship.fuel - plan.fuelUsed);

    const advanced = await this.world.advanceMinutes(plan.hours * 60);
    const time = advanced.info;
    const isNight = time.day_night === 'night';

    const encounter = await this.resolveEncounter(character, time, plan.hours, isNight, warnings, mode === 'drift' ? 90 : undefined);

    await this.characters.save(character);
    await this.characters.saveShip(ship);

    const fuelText =
      mode === 'drift'
        ? '这次漂流没有烧油。'
        : plan.fuelUsed <= 0
          ? plan.alongCurrent
            ? '顺着洋流走，没有烧油。'
            : '没有烧油。'
          : `消耗燃料 ${round1(plan.fuelUsed)} 单位。`;

    const directionText = bearingText(plan.bearing);
    const narration = await this.renderTravelFast(mode, {
      direction_text: directionText,
      distance: plan.distance,
      hours: plan.hours,
      fuel_text: fuelText,
      scenery: SCENERY[Math.floor(Math.random() * SCENERY.length)],
      boundary_text: warnings.find((w) => w.type === 'sea_boundary')?.text ?? '',
    }, { userId: character.user_id, tier: 'small' }, mode === 'sail'
      ? `你把舵转向${directionText}，${round1(plan.distance)} 海里后，${SCENERY[Math.floor(Math.random() * SCENERY.length)]}。这一程耗去 ${plan.hours} 个世界小时，${fuelText}`
      : `你松开舵，让洋流带着船走。一个世界小时过去，船漂出 ${round1(plan.distance)} 海里，${fuelText}`);

    let encounterNarration: TravelResult['encounter_narration'];
    if (encounter) {
      encounterNarration = await this.renderEncounterFast(
        encounter,
        character.user_id,
      );
    }

    return {
      character,
      ship,
      from,
      to: { x: plan.x, y: plan.y },
      distance: plan.distance,
      hours: plan.hours,
      fuelUsed: plan.fuelUsed,
      along_current: plan.alongCurrent,
      time,
      narration,
      encounter,
      encounter_narration: encounterNarration,
      warnings,
    };
  }

  /**
   * 遭遇（§4.1）+ 2 世界小时必遇兜底。
   * 兜底实现：连续航行累计 2 世界小时未遭遇时，洋流把船送到最近岛屿的遭遇圈内。
   */
  // ------------------------------------------------------------ 叙述加速

  /** 模型 2.5 秒内回不来就用模板，保证航行/遭遇事件不被免费模型队列卡住 */
  private async renderTravelFast(
    mode: 'sail' | 'drift',
    data: Record<string, any>,
    opts: { userId: string; tier: 'small' },
    fallback: string,
  ): Promise<{ text: string; source: string; degraded: boolean }> {
    try {
      const raced = await Promise.race([
        this.narrator.render(mode, data, opts),
        new Promise<null>((resolve) => {
          const timer = setTimeout(() => resolve(null), 2500);
          timer.unref?.();
        }),
      ]);
      if (raced) return raced;
    } catch {
      /* 回退模板 */
    }
    return { text: fallback, source: 'template', degraded: true };
  }

  private async renderEncounterFast(
    encounter: NonNullable<TravelResult['encounter']>,
    userId: string,
  ): Promise<{ text: string; source: string; degraded: boolean }> {
    try {
      const raced = await Promise.race([
        this.narrator.render(
          'encounter',
          { name: encounter.island.name, distance: encounter.distance, hint: encounter.hint },
          { userId, tier: 'small' },
        ),
        new Promise<null>((resolve) => {
          const timer = setTimeout(() => resolve(null), 2500);
          timer.unref?.();
        }),
      ]);
      if (raced) return raced;
    } catch {
      /* 回退模板 */
    }
    return {
      text: `${encounter.island.name}的轮廓从雾里浮出来。${encounter.hint}`,
      source: 'template',
      degraded: true,
    };
  }

  private async resolveEncounter(
    character: Character,
    time: WorldTimeInfo,
    hours: number,
    isNight: boolean,
    warnings: { type: string; text: string }[],
    guaranteeMinutes?: number,
  ): Promise<TravelResult['encounter']> {
    const key = `encounter:char:${character.id}`;
    const elapsedMinutes = Number.parseInt((await this.kv.get(key)) ?? '0', 10);

    const found = await this.islands.findEncounter(character.x, character.y, isNight);
    if (found) {
      await this.kv.del(key);
      const distance = distanceNm(character.x, character.y, found.x, found.y);
      const bearing = bearingDeg(character.x, character.y, found.x, found.y);
      return {
        island: found,
        distance,
        hint: `岛影在${bearingText(bearing)}方向，看不清细节。`,
      };
    }

    const accumulated = elapsedMinutes + Math.round(hours * 60);
    const threshold = guaranteeMinutes ?? GAME.ENCOUNTER_GUARANTEE_MINUTES;
    this.logger.log(`遭遇判定 char=${character.id} elapsed=${elapsedMinutes} +${Math.round(hours * 60)} acc=${accumulated} thr=${threshold}`);
    if (accumulated < threshold) {
      await this.kv.set(key, String(accumulated), 6 * 3600);
      return undefined;
    }

    // 兜底：洋流引导到最近岛屿
    const nearest = await this.islands.nearest(character.x, character.y);
    if (!nearest) return undefined;

    const range = this.islands.encounterRange(isNight);
    // 引导位置需同时落在影响半径内，否则玩家「遭遇了却进不去」
    const target = Math.max(0.5, Math.min(range - 1, nearest.island.radius * 0.8));
    const bearing = Math.atan2(nearest.island.y - character.y, nearest.island.x - character.x);
    character.x = nearest.island.x - Math.cos(bearing) * target;
    character.y = nearest.island.y - Math.sin(bearing) * target;

    await this.kv.del(key);
    warnings.push({
      type: 'current_guidance',
      text: '洋流换了向，把船一路推向有岛的水域。',
    });
    return {
      island: nearest.island,
      distance: target,
      hint: '洋流把船送到了岛的边缘，你能看清岸上的轮廓了。',
    };
  }
}

