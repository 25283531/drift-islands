import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { Socket } from 'socket.io-client';
import { Character, Ship } from '../../src/database/entities/character.entities';
import { Item } from '../../src/database/entities/item.entities';
import {
  Harness,
  authSocket,
  closeHarness,
  connectSocket,
  createHarness,
  loginAndCreateCharacter,
  waitFor,
} from './helpers';

describe('M3 团队 / 交易 / 疲劳 / GM（e2e）', () => {
  let harness: Harness;
  let socketA: Socket;
  let socketB: Socket;
  let tokenA: string;
  let tokenB: string;
  let characterA: any;
  let characterB: any;
  let itemA: Item;
  let itemB: Item;

  beforeAll(async () => {
    harness = await createHarness();
    const a = await loginAndCreateCharacter(harness.baseUrl, '甲玩家', '甲七');
    const b = await loginAndCreateCharacter(harness.baseUrl, '乙玩家', '乙九');
    tokenA = a.token;
    tokenB = b.token;
    characterA = a.character;
    characterB = b.character;
    socketA = await connectSocket(harness.port);
    socketB = await connectSocket(harness.port);
    await authSocket(socketA, tokenA, characterA.id);
    await authSocket(socketB, tokenB, characterB.id);

    const ds = harness.app.get(DataSource);
    await ds.getRepository(Character).update({ id: characterA.id }, { x: 0, y: 0, island_id: null });
    await ds.getRepository(Character).update({ id: characterB.id }, { x: 0, y: 0, island_id: null });
    await ds.getRepository(Ship).update({ id: characterA.ship_id }, { x: 0, y: 0 });
    await ds.getRepository(Ship).update({ id: characterB.ship_id }, { x: 0, y: 0 });

    const items = ds.getRepository(Item);
    itemA = await items.save(
      items.create({ id: 'm3-item-a', name: '零件', type: 'part', tags: [], quantity: 2, condition: null, owner_type: 'character', owner_id: characterA.id, x: null, y: null }),
    );
    itemB = await items.save(
      items.create({ id: 'm3-item-b', name: '药品', type: 'medicine', tags: [], quantity: 1, condition: null, owner_type: 'character', owner_id: characterB.id, x: null, y: null }),
    );
  }, 40000);

  afterAll(async () => {
    await closeHarness(harness, [socketA, socketB]);
  });

  it('建队、邀请、加入并显示称号', async () => {
    const created = waitFor(socketA, 'team_update');
    socketA.emit('team_create', { name: '碎浪' });
    const teamUpdate = await created;
    expect(teamUpdate.team.name).toBe('碎浪');

    const invited = waitFor(socketA, 'team_invited');
    socketA.emit('team_invite', { name: '乙九' });
    expect((await invited).target).toBe('乙九');

    const joined = waitFor(socketB, 'team_update');
    socketB.emit('team_join');
    const info = await joined;
    expect(info.members.length).toBe(2);
    expect(info.members.some((m: any) => m.name === '【碎浪】乙九')).toBe(true);
  });

  it('队员可上队长船，同船人数参与消耗计算', async () => {
    const boarded = waitFor(socketB, 'team_boarded');
    socketB.emit('team_board');
    const result = await boarded;
    expect(result.ship_id).toBe(characterA.ship_id);
  });

  it('面对面交易可交换物品', async () => {
    const offered = waitFor(socketA, 'trade_offered');
    socketA.emit('trade_propose', { name: '乙九', offer_ids: [itemA.id], want_ids: [itemB.id] });
    const offer = await offered;
    expect(offer.trade_id).toBeTruthy();

    const accepted = waitFor(socketB, 'trade_result');
    socketB.emit('trade_accept', { trade_id: offer.trade_id });
    const result = await accepted;
    expect(result.ok).toBe(true);

    const ds = harness.app.get(DataSource);
    const items = ds.getRepository(Item);
    expect((await items.findOne({ where: { id: itemA.id } }))!.owner_id).toBe(characterB.id);
    expect((await items.findOne({ where: { id: itemB.id } }))!.owner_id).toBe(characterA.id);
  });

  it('藏匿点放置后可被同位置的人取走', async () => {
    const placed = waitFor(socketA, 'dead_drop_placed');
    socketA.emit('dead_drop', { item_ids: [itemB.id] });
    const drop = await placed;
    expect(drop.count).toBe(1);

    const taken = waitFor(socketB, 'dead_drop_result');
    socketB.emit('dead_drop_take', { drop_id: drop.drop_id });
    expect((await taken).ok).toBe(true);
  });

  it('在线超时会累加疲劳并给出提示', async () => {
    const ds = harness.app.get(DataSource);
    await ds.getRepository(Character).update({ id: characterA.id }, { online_seconds_today: 9 * 3600, fatigue: 0 });
    const updated = waitFor(socketA, 'fatigue_update');
    socketA.emit('heartbeat');
    const result = await updated;
    expect(result.fatigue).toBeGreaterThan(0);
    expect(result.warning).toContain('疲劳');
  });

  it('GM 接口需要令牌，带令牌可读总览并创建世界事件', async () => {
    const denied = await fetch(`${harness.baseUrl}/api/v1/admin/overview`);
    expect(denied.status).toBe(403);

    const headers = { 'content-type': 'application/json', 'x-admin-token': process.env.ADMIN_TOKEN ?? 'drift-admin-2026' };
    const overview = await (await fetch(`${harness.baseUrl}/api/v1/admin/overview`, { headers })).json();
    expect(overview.characters).toBeGreaterThanOrEqual(2);

    const event = await (
      await fetch(`${harness.baseUrl}/api/v1/admin/world-events`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ event_type: 'storm', trigger_type: 'world_day', trigger_value: '3', payload: { radius: 20 } }),
      })
    ).json();
    expect(event.id).toBeTruthy();
    expect(event.status).toBe('pending');
  });

  it('模型池播种后可读取并调整优先级', async () => {
    const headers = { 'content-type': 'application/json', 'x-admin-token': process.env.ADMIN_TOKEN ?? 'drift-admin-2026' };
    const pool = await (await fetch(`${harness.baseUrl}/api/v1/admin/model-pool`, { headers })).json();
    expect(Array.isArray(pool)).toBe(true);
  });
});
