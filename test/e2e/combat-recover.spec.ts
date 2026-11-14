import { DataSource } from 'typeorm';
import { Socket } from 'socket.io-client';
import { CombatService } from '../../src/combat/combat.service';
import { Character, Ship } from '../../src/database/entities/character.entities';
import { Monster } from '../../src/database/entities/island.entities';
import { FIXED_IDS } from '../../src/database/seed.service';
import {
  Harness,
  authSocket,
  closeHarness,
  connectSocket,
  createHarness,
  loginAndCreateCharacter,
  waitFor,
} from './helpers';

describe('战斗遗留回收（e2e）', () => {
  let harness: Harness;
  let socket: Socket;
  let character: any;
  let ship: any;

  beforeAll(async () => {
    harness = await createHarness();
    const player = await loginAndCreateCharacter(harness.baseUrl, '回收测试', '回收者');
    character = player.character;
    ship = player.ship;
    socket = await connectSocket(harness.port);
    await authSocket(socket, player.token, character.id);
  }, 20000);

  afterAll(async () => {
    await closeHarness(harness, [socket]);
  });

  it('没有活跃会话时，卡在 combat 的怪物会被释放回 idle', async () => {
    const ds = harness.app.get(DataSource);
    await ds.getRepository(Monster).update(
      { island_id: FIXED_IDS.PRESET_ISLAND },
      { state: 'combat' },
    );
    const stuck = (await ds.getRepository(Monster).find({ where: { island_id: FIXED_IDS.PRESET_ISLAND } }))[0];
    await ds.getRepository(Monster).update({ id: stuck.id }, { hp: 0 });

    const combat = harness.app.get(CombatService);
    const result = await combat.recover(FIXED_IDS.PRESET_ISLAND);
    expect(result.released).toBeGreaterThan(0);

    const rows = await ds.getRepository(Monster).find({ where: { island_id: FIXED_IDS.PRESET_ISLAND } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.state === 'idle' && row.hp > 0)).toBe(true);
  });

  it('进岛正常开战；角色掉线后的孤儿会话被清掉、怪物回收', async () => {
    const ds = harness.app.get(DataSource);
    await ds.getRepository(Character).update(
      { id: character.id },
      { x: harness.island.x, y: harness.island.y, island_id: null },
    );
    await ds.getRepository(Ship).update({ id: ship.id }, { x: harness.island.x, y: harness.island.y });

    // 服务重启后残留的 combat 怪物不该挡住开战
    await ds.getRepository(Monster).update(
      { island_id: FIXED_IDS.PRESET_ISLAND },
      { state: 'combat' },
    );
    const deadStuck = (await ds.getRepository(Monster).find({ where: { island_id: FIXED_IDS.PRESET_ISLAND } }))[0];
    await ds.getRepository(Monster).update({ id: deadStuck.id }, { hp: 0 });

    const roundStart = waitFor(socket, 'combat_round_start', undefined, 10000);
    socket.emit('enter_island', { island_id: FIXED_IDS.PRESET_ISLAND });
    const start = await roundStart;
    expect(start.round).toBe(1);
    expect(start.participants.some((p: any) => p.side === 'monster')).toBe(true);
    const queue = start.participants.filter((p: any) => p.side === 'monster');
    // 进入战斗用的是重新读取后的怪物，不能拿恢复前的 0 血对象
    expect(queue.length).toBeGreaterThan(0);
    expect(queue.every((p: any) => p.hp > 0)).toBe(true);

    // 模拟角色已不在战斗状态（掉线/被踢），会话成为孤儿
    await ds.getRepository(Character).update({ id: character.id }, { status: 'offline' });

    const combat = harness.app.get(CombatService);
    const cleaned = await combat.recover(FIXED_IDS.PRESET_ISLAND);
    expect(cleaned.sessions).toBeGreaterThan(0);
    expect(cleaned.released).toBeGreaterThan(0);
    expect(combat.activeFor(character.id)).toBeNull();

    const rows = await ds.getRepository(Monster).find({ where: { island_id: FIXED_IDS.PRESET_ISLAND } });
    expect(rows.every((row) => row.state !== 'combat')).toBe(true);
  }, 30000);
});
