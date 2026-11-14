import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Socket } from 'socket.io-client';
import {
  Harness,
  angleTo,
  authSocket,
  closeHarness,
  connectSocket,
  createHarness,
  jsonFetch,
  loginAndCreateCharacter,
  waitFor,
} from './helpers';

describe('M1 验收：核心循环（注册 → 建角 → 移动 → 遭遇 → 进岛 → 战斗一回合 → AI 叙述）', () => {
  let harness: Harness;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await closeHarness(harness, sockets);
  });

  it('完整跑通一次单岛遭遇与一回合战斗', async () => {
    const suffix = Date.now() % 100000;
    const { token, character } = await loginAndCreateCharacter(harness.baseUrl, `水手${suffix}`, `阿海${suffix % 1000}`);

    const socket = await connectSocket(harness.port);
    sockets.push(socket);
    const authenticated = await authSocket(socket, token, character.id);
    expect(authenticated.character.name).toBeTruthy();
    expect(authenticated.channels.sea).toBeTruthy();

    // 世界状态可读
    const world = await jsonFetch(harness.baseUrl, '/api/v1/world');
    expect(world.world_day).toBeGreaterThanOrEqual(1);
    expect(['day', 'night']).toContain(world.day_night);
    expect(world.sea_radius_nm).toBeGreaterThan(0);

    // 朝预置岛屿航行（单次上限 20 海里内）
    const from = { x: character.x, y: character.y };
    const distance = Math.hypot(harness.island.x - from.x, harness.island.y - from.y);
    expect(distance).toBeLessThanOrEqual(20);

    const sailNarration = waitFor(socket, 'narration', (p) => p.kind === 'sail');
    const encounterPromise = waitFor(socket, 'encounter', undefined, 8000);
    socket.emit('move', { angle: angleTo(from, harness.island), distance_nm: distance });

    const narration = await sailNarration;
    expect(narration.text.length).toBeGreaterThan(6);

    const encounter = await encounterPromise;
    expect(encounter.island_id).toBe(harness.island.id);
    expect(encounter.name).toBe(harness.island.name);
    expect(encounter.distance_nm).toBeLessThanOrEqual(12);

    // 进岛：加入岛屿子频道并开战
    const roundStartPromise = waitFor(socket, 'combat_round_start', undefined, 8000);
    socket.emit('enter_island', { island_id: encounter.island_id });
    const roundStart = await roundStartPromise;

    expect(roundStart.round).toBe(1);
    expect(roundStart.deadline_ms).toBeGreaterThan(0);
    const monster = roundStart.participants.find((p: any) => p.side === 'monster');
    expect(monster).toBeTruthy();

    // 提交攻击，等待一回合结算与叙述
    socket.emit('combat_action', {
      combat_id: roundStart.combat_id,
      action: 'attack',
      target_id: monster.id,
    });
    const roundResult = await waitFor(socket, 'combat_round_result', undefined, 8000);

    expect(roundResult.round).toBe(1);
    expect(typeof roundResult.narration).toBe('string');
    expect(roundResult.narration.length).toBeGreaterThan(6);
    expect(roundResult.results.length).toBeGreaterThan(1);

    const hitMonster = roundResult.results.find((r: any) => r.side === 'monster');
    expect(hitMonster.hp).toBeLessThan(hitMonster.max_hp);

    // 角色已进入岛屿、状态在战斗中
    const detail = await jsonFetch(harness.baseUrl, `/api/v1/characters/${character.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(detail.character.island_id).toBe(harness.island.id);
  }, 30000);
});
