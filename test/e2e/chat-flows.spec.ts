import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { Socket } from 'socket.io-client';
import { Character, Ship } from '../../src/database/entities/character.entities';
import { Item } from '../../src/database/entities/item.entities';
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

describe('对话式交易 / 驻扎 / 漂流保底（e2e）', () => {
  let harness: Harness;
  let socketA: Socket;
  let socketB: Socket;
  let characterA: any;
  let characterB: any;

  beforeAll(async () => {
    harness = await createHarness();
    const a = await loginAndCreateCharacter(harness.baseUrl, '交易甲', '货郎甲');
    const b = await loginAndCreateCharacter(harness.baseUrl, '交易乙', '货郎乙');
    characterA = a.character;
    characterB = b.character;
    socketA = await connectSocket(harness.port);
    socketB = await connectSocket(harness.port);
    await authSocket(socketA, a.token, characterA.id);
    await authSocket(socketB, b.token, characterB.id);

    const ds = harness.app.get(DataSource);
    // 回归：两人都在海上但相距 28 海里，同海即可交易，不再卡“必须面对面”
    await ds.getRepository(Character).update({ id: characterA.id }, { x: 0, y: 0, island_id: null });
    await ds.getRepository(Character).update({ id: characterB.id }, { x: 20, y: 20, island_id: null });
    await ds.getRepository(Ship).update({ id: characterA.ship_id }, { x: 0, y: 0 });
    await ds.getRepository(Ship).update({ id: characterB.ship_id }, { x: 20, y: 20 });

    const items = ds.getRepository(Item);
    await items.save(
      items.create({ id: 'flow-part', name: '零件', type: 'part', tags: [], quantity: 2, condition: null, owner_type: 'character', owner_id: characterA.id, x: null, y: null }),
    );
    await items.save(
      items.create({ id: 'flow-med', name: '药品', type: 'medicine', tags: [], quantity: 1, condition: null, owner_type: 'character', owner_id: characterB.id, x: null, y: null }),
    );
  }, 40000);

  afterAll(async () => {
    await closeHarness(harness, [socketA, socketB]);
  });

  it('交易全程用对话完成，另一方用「接受交易」确认', async () => {
    let p = waitFor(socketA, 'narration', (n) => n.text.includes('和谁换'), 8000);
    socketA.emit('chat', { channel_id: FIXED_IDS.SEA_CHANNEL, text: '交易' });
    await p;

    p = waitFor(socketA, 'narration', (n) => n.text.includes('你给出什么'), 8000);
    socketA.emit('chat', { channel_id: FIXED_IDS.SEA_CHANNEL, text: '货郎乙' });
    await p;

    p = waitFor(socketA, 'narration', (n) => n.text.includes('要对方给你什么'), 8000);
    socketA.emit('chat', { channel_id: FIXED_IDS.SEA_CHANNEL, text: '零件' });
    await p;

    p = waitFor(socketA, 'narration', (n) => n.text.includes('交易内容'), 8000);
    socketA.emit('chat', { channel_id: FIXED_IDS.SEA_CHANNEL, text: '药品' });
    await p;

    const invited = waitFor(socketB, 'narration', (n) => n.text.includes('想和你交易'), 8000);
    p = waitFor(socketA, 'narration', (n) => n.text.includes('邀请已发'), 8000);
    socketA.emit('chat', { channel_id: FIXED_IDS.SEA_CHANNEL, text: '确认交易' });
    await p;
    await invited;

    const accepted = waitFor(socketB, 'narration', (n) => n.text.includes('甲板'), 8000);
    socketB.emit('chat', { channel_id: FIXED_IDS.SEA_CHANNEL, text: '接受交易' });
    await accepted;

    const items = harness.app.get(DataSource).getRepository(Item);
    expect((await items.findOne({ where: { id: 'flow-part' } }))!.owner_id).toBe(characterB.id);
    expect((await items.findOne({ where: { id: 'flow-med' } }))!.owner_id).toBe(characterA.id);
  });

  it('上岛后可以用「驻扎」→「确认驻扎」建立基地', async () => {
    const ds = harness.app.get(DataSource);
    await ds.getRepository(Monster).delete({ island_id: FIXED_IDS.PRESET_ISLAND });
    await ds.getRepository(Character).update({ id: characterA.id }, { island_id: FIXED_IDS.PRESET_ISLAND });

    let p = waitFor(socketA, 'narration', (n) => n.text.includes('确认在这座岛'), 8000);
    socketA.emit('chat', { channel_id: FIXED_IDS.SEA_CHANNEL, text: '驻扎' });
    await p;

    p = waitFor(socketA, 'base_update', undefined, 10000);
    const base = waitFor(socketA, 'narration', () => true, 10000);
    socketA.emit('chat', { channel_id: FIXED_IDS.SEA_CHANNEL, text: '确认驻扎' });
    const updated = await p;
    await base;
    expect(updated.base || updated.buildings).toBeTruthy();
  });
});

describe('漂流不会一直遇不到岛（e2e）', () => {
  let harness: Harness;
  let socket: Socket;

  beforeAll(async () => {
    harness = await createHarness();
    const created = await loginAndCreateCharacter(harness.baseUrl, '漂流者', '浮标');
    socket = await connectSocket(harness.port);
    await authSocket(socket, created.token, created.character.id);
  }, 40000);

  afterAll(async () => {
    await closeHarness(harness, [socket]);
  });

  it('两次漂流内至少遭遇一座岛', async () => {
    const encounter = waitFor(socket, 'encounter', undefined, 30000);
    let p = waitFor(socket, 'narration', (n) => n.text.includes('松开舵'), 10000);
    socket.emit('chat', { channel_id: FIXED_IDS.SEA_CHANNEL, text: '漂流' });
    await p;

    p = waitFor(socket, 'narration', (n) => n.text.includes('松开舵'), 10000);
    socket.emit('chat', { channel_id: FIXED_IDS.SEA_CHANNEL, text: '漂流' });
    await p;

    const found = await encounter;
    expect(found.name).toBeTruthy();
  });
});
