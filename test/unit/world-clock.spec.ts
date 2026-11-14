import { describe, expect, it } from 'vitest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { WorldService } from '../../src/world/world.service';
import { KvService } from '../../src/redis/kv.service';

function harness(worldMinutes = 950, worldDay = 1) {
  let state: any = {
    id: 1,
    world_day: worldDay,
    world_minutes: worldMinutes,
    sea_radius_nm: 50,
    island_count: 1,
    current_direction: 45,
    last_tick_at: new Date(Date.now() - 40_000),
  };
  const repo = {
    findOne: async () => ({ ...state }),
    save: async (next: any) => {
      state = { ...next };
      return state;
    },
  };
  const service = new WorldService(repo as any, new KvService(), new EventEmitter2());
  return { service, snapshot: () => state };
}

describe('世界时钟（§3）', () => {
  it('白天 0–959 世界分钟，夜晚 960 起', () => {
    const { service } = harness();
    expect(service.infoOf({ world_day: 1, world_minutes: 959 }).day_night).toBe('day');
    expect(service.infoOf({ world_day: 1, world_minutes: 960 }).day_night).toBe('night');
  });

  it('1 世界分钟 = 20 现实秒：40 秒补 2 分钟', async () => {
    const { service, snapshot } = harness(950);
    await service.tick(new Date());
    expect(snapshot().world_minutes).toBe(952);
  });

  it('航行消耗世界时间会跨日并刷新洋流', async () => {
    const { service, snapshot } = harness(950);
    const result = await service.advanceMinutes(600);
    expect(result.day_changed).toBe(true);
    expect(snapshot().world_day).toBe(2);
    expect(snapshot().world_minutes).toBe(110);
    expect(snapshot().current_direction).toBeCloseTo(service.randomDirection(2));
  });

  it('同一世界日的洋流方向是确定的', () => {
    const { service } = harness();
    expect(service.randomDirection(3)).toBe(service.randomDirection(3));
    expect(service.randomDirection(3)).not.toBe(service.randomDirection(4));
  });

  it('世界时间文本包含世界日与昼夜', async () => {
    const { service } = harness(1000);
    const info = await service.timeInfo();
    expect(info.text).toContain('世界日 1');
    expect(info.text).toContain('夜晚');
  });
});
