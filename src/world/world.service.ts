import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { envInt } from '../common/env';
import { WorldState } from '../database/entities/world.entities';
import { DAY_NIGHT, DayNight, GAME } from '../game/constants';
import { KvService } from '../redis/kv.service';

export interface WorldTimeInfo {
  world_day: number;
  world_minutes: number;
  world_hour: number;
  day_night: DayNight;
  /** 世界时间文本，如 “世界日 1 · 06:00（白天）” */
  text: string;
}

/**
 * 世界时钟（§3、§1.14、§1.23）。
 * 每 20 现实秒推进 1 世界分钟；白天 0–959 世界分钟，夜晚 960–1439。
 * 航行会额外消耗世界时间：advanceMinutes() 立即推进世界时钟。
 */
@Injectable()
export class WorldService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorldService.name);
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    @InjectRepository(WorldState) private readonly repo: Repository<WorldState>,
    private readonly kv: KvService,
    private readonly events: EventEmitter2,
  ) {}

  onModuleInit(): void {
    const interval = envInt('WORLD_TICK_MS', 5000);
    if (interval > 0) {
      this.timer = setInterval(() => {
        void this.tick();
      }, interval);
      this.timer.unref?.();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async getState(): Promise<WorldState> {
    const state = await this.repo.findOne({ where: { id: 1 } });
    if (!state) {
      throw new Error('world_state 未初始化：应先执行种子数据');
    }
    return state;
  }

  isNight(worldMinutes: number): boolean {
    return worldMinutes >= GAME.DAY_MINUTES;
  }

  infoOf(state: Pick<WorldState, 'world_day' | 'world_minutes'>): WorldTimeInfo {
    const dayNight = this.isNight(state.world_minutes) ? DAY_NIGHT.NIGHT : DAY_NIGHT.DAY;
    const hour = Math.floor(state.world_minutes / 60);
    const minute = state.world_minutes % 60;
    return {
      world_day: state.world_day,
      world_minutes: state.world_minutes,
      world_hour: hour,
      day_night: dayNight,
      text: `世界日 ${state.world_day} · ${String(hour).padStart(2, '0')}:${String(minute).padStart(
        2,
        '0',
      )}（${dayNight === DAY_NIGHT.DAY ? '白天' : '夜晚'}）`,
    };
  }

  async timeInfo(): Promise<WorldTimeInfo> {
    return this.infoOf(await this.getState());
  }

  /** 现实时间驱动的世界时钟推进（每 20 现实秒 = 1 世界分钟） */
  async tick(now: Date = new Date()): Promise<WorldTimeInfo | null> {
    if (this.ticking) return null;
    this.ticking = true;
    try {
      const state = await this.getState();
      const last = new Date(state.last_tick_at).getTime();
      const elapsedMinutes = Math.floor((now.getTime() - last) / (GAME.REAL_SECONDS_PER_WORLD_MINUTE * 1000));
      if (elapsedMinutes <= 0) return this.infoOf(state);

      const applied = Math.min(elapsedMinutes, GAME.WORLD_MINUTES_PER_DAY * 30);
      const advanced = await this.advanceMinutes(applied, { driveByRealTime: true });
      const next = await this.getState();
      const info = this.infoOf(next);
      this.events.emit('world.tick', {
        ...info,
        current: next.current_direction,
        sea_radius_nm: next.sea_radius_nm,
        day_changed: advanced.day_changed,
        new_day: advanced.new_day,
      });
      return info;
    } finally {
      this.ticking = false;
    }
  }

  /**
   * 立即推进世界分钟（航行耗时、漂流耗时都走这里）。
   * 跨日时刷新洋流方向（§4.1：每天一条洋流方向），并派发 world.day 事件。
   */
  async advanceMinutes(
    minutes: number,
    opts: { driveByRealTime?: boolean } = {},
  ): Promise<{ day_changed: boolean; new_day: number; info: WorldTimeInfo }> {
    const state = await this.getState();
    const safeMinutes = Math.max(0, Math.min(Math.round(minutes), GAME.WORLD_MINUTES_PER_DAY * 30));

    let day = state.world_day;
    let worldMinutes = state.world_minutes + safeMinutes;
    let dayChanged = false;
    while (worldMinutes >= GAME.WORLD_MINUTES_PER_DAY) {
      worldMinutes -= GAME.WORLD_MINUTES_PER_DAY;
      day += 1;
      dayChanged = true;
    }

    state.world_day = day;
    state.world_minutes = worldMinutes;
    if (dayChanged) {
      state.current_direction = this.randomDirection(day);
    }
    // 现实驱动的推进保留上次 tick 的取整余量；航行耗时以“现在”为新基准
    state.last_tick_at = opts.driveByRealTime
      ? new Date(new Date(state.last_tick_at).getTime() + safeMinutes * GAME.REAL_SECONDS_PER_WORLD_MINUTE * 1000)
      : new Date();
    await this.repo.save(state);

    const info = this.infoOf(state);
    if (dayChanged) {
      this.events.emit('world.day', {
        ...info,
        current: state.current_direction,
      });
      this.logger.log(`世界进入第 ${day} 日，洋流方向 ${state.current_direction}°`);
    }
    return { day_changed: dayChanged, new_day: day, info };
  }

  /** 洋流方向：按世界日确定性生成，便于复算与测试 */
  randomDirection(worldDay: number): number {
    const seed = Math.sin(worldDay * 12.9898) * 43758.5453;
    const frac = seed - Math.floor(seed);
    return Math.round(frac * 3600) / 10;
  }

  async setCurrentDirection(deg: number): Promise<void> {
    const state = await this.getState();
    state.current_direction = ((deg % 360) + 360) % 360;
    await this.repo.save(state);
  }

  /** 世界日变化后刷新岛屿数 / 海域半径（§4.1 容量扩展） */
  async syncSeaCapacity(islandCount: number): Promise<{ radius: number; expanded: boolean }> {
    const state = await this.getState();
    let radius = state.sea_radius_nm;
    let expanded = false;
    // 容量：每 250 平方海里 1 座岛；达到 80% 则半径 +25 海里
    while (islandCount >= 0.8 * ((Math.PI * radius * radius) / 250)) {
      radius += 25;
      expanded = true;
    }
    state.island_count = islandCount;
    state.sea_radius_nm = radius;
    await this.repo.save(state);
    return { radius, expanded };
  }
}
