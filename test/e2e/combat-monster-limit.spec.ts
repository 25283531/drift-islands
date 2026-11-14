import { DataSource } from 'typeorm';
import { Socket } from 'socket.io-client';
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

describe('进岛参战怪物数量上限（e2e）', () => {
  let harness: Harness;
  let socket: Socket;
  let character: any;

  beforeAll(async () => {
    harness = await createHarness();
    const player = await loginAndCreateCharacter(harness.baseUrl, '上限测试', '新手上限');
    character = player.character;
    socket = await connectSocket(harness.port);
    await authSocket(socket, player.token, character.id);

    const ds = harness.app.get(DataSource);
    await ds.getRepository(Monster).update(
      { island_id: FIXED_IDS.PRESET_ISLAND },
      { state: 'idle' },
    );
    await ds.getRepository(Character).update(
      { id: character.id },
      { x: harness.island.x, y: harness.island.y, island_id: null, level: 0 },
    );
    await ds.getRepository(Ship).update(
      { id: player.ship.id },
      { x: harness.island.x, y: harness.island.y },
    );
  }, 20000);

  afterAll(async () => {
    await closeHarness(harness, [socket]);
  });

  it('Lv0 进岛只惊动 1 只怪，其余留在暗处', async () => {
    const warnings: any[] = [];
    socket.on('warning', (w) => warnings.push(w));

    const roundStart = waitFor(socket, 'combat_round_start', undefined, 10000);
    socket.emit('enter_island', { island_id: FIXED_IDS.PRESET_ISLAND });
    const start = await roundStart;

    const monsters = start.participants.filter((p: any) => p.side === 'monster');
    expect(monsters).toHaveLength(1);
    expect(start.queue).toHaveLength(1);

    const limit = warnings.find((w) => w.type === 'monster_limit');
    expect(limit).toBeTruthy();
    expect(limit.text).toContain('1 只');
  }, 20000);
});
