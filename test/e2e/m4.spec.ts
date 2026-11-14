import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { Socket } from 'socket.io-client';
import { User } from '../../src/database/entities/user.entity';
import { Island } from '../../src/database/entities/island.entities';
import { FIXED_IDS } from '../../src/database/seed.service';
import {
  Harness,
  authSocket,
  closeHarness,
  connectSocket,
  createHarness,
  jsonFetch,
  loginAndCreateCharacter,
  waitFor,
} from './helpers';

const ADMIN = { 'x-admin-token': 'drift-admin-2026' };

describe('M4 评分 / 激励 / 举报（e2e）', () => {
  let harness: Harness;
  let socketB: Socket;
  let creatorToken: string;
  let playerToken: string;
  let player: any;
  let creatorUserId: string;

  beforeAll(async () => {
    harness = await createHarness();
    const creator = await loginAndCreateCharacter(harness.baseUrl, 'M4甲', '岛主甲');
    const b = await loginAndCreateCharacter(harness.baseUrl, 'M4乙', '访客乙');
    creatorToken = creator.token;
    playerToken = b.token;
    player = b.character;

    const ds = harness.app.get(DataSource);
    creatorUserId = (await ds.getRepository(User).findOne({ where: { display_name: 'M4甲' } }))!.id;

    socketB = await connectSocket(harness.port);
    await authSocket(socketB, playerToken, player.id);
  }, 40000);

  afterAll(async () => {
    await closeHarness(harness, [socketB]);
  });

  it('玩家打分后，岛屿评分与榜单能读到', async () => {
    const rated = await jsonFetch(harness.baseUrl, `/api/v1/islands/${FIXED_IDS.PRESET_ISLAND}/rate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${playerToken}` },
      body: JSON.stringify({ score: 5, comment: '岛上还能修船，值' }),
    });
    expect(rated.rating_count).toBe(1);
    expect(rated.avg_rating).toBe(5);

    const again = await jsonFetch(harness.baseUrl, `/api/v1/islands/${FIXED_IDS.PRESET_ISLAND}/rate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${playerToken}` },
      body: JSON.stringify({ score: 4 }),
    });
    expect(again.rating_count).toBe(1);
    expect(again.avg_rating).toBe(4);

    const top = await jsonFetch(harness.baseUrl, '/api/v1/rankings/islands?limit=5', {
      headers: { authorization: `Bearer ${playerToken}` },
    });
    expect(Array.isArray(top.islands)).toBe(true);
    expect(top.islands.some((row: any) => row.island_id === FIXED_IDS.PRESET_ISLAND)).toBe(true);
  });

  it('激励结算按评分发放，写入台账且重复结算不重复发', async () => {
    const ds = harness.app.get(DataSource);
    await ds.getRepository(Island).update(
      { id: FIXED_IDS.PRESET_ISLAND },
      { creator_user_id: creatorUserId, visit_count: 80, resources_taken: 200, last_visit_world_day: 1 },
    );

    const first = await jsonFetch(harness.baseUrl, '/api/v1/admin/rewards/settle', {
      method: 'POST',
      headers: ADMIN,
      body: JSON.stringify({ period_day: 1 }),
    });
    expect(first.granted_count).toBe(1);
    expect(first.granted[0].amount).toBe(300);
    expect(first.granted[0].creator_user_id).toBe(creatorUserId);

    const second = await jsonFetch(harness.baseUrl, '/api/v1/admin/rewards/settle', {
      method: 'POST',
      headers: ADMIN,
      body: JSON.stringify({ period_day: 1 }),
    });
    expect(second.granted_count).toBe(0);

    const list = await jsonFetch(harness.baseUrl, '/api/v1/admin/rewards', { headers: ADMIN });
    const row = list.find((item: any) => item.island_id === FIXED_IDS.PRESET_ISLAND);
    expect(row).toBeTruthy();
    expect(row.score).toBeGreaterThan(60);
    expect(row.settled_by).toBe('gm');

    const mine = await jsonFetch(harness.baseUrl, '/api/v1/me/rewards', {
      headers: { authorization: `Bearer ${creatorToken}` },
    });
    expect(mine.total).toBeGreaterThanOrEqual(300);
  });

  it('举报 → 审核 → 禁言闭环跑通', async () => {
    const said = waitFor(socketB, 'chat_message', (data) => data?.message?.sender_character_id === player.id, 8000);
    socketB.emit('chat', { channel_id: FIXED_IDS.SEA_CHANNEL, text: '这是一条会被举报的发言' });
    const message = (await said).message;

    const report = await jsonFetch(harness.baseUrl, '/api/v1/reports', {
      method: 'POST',
      headers: { authorization: `Bearer ${creatorToken}` },
      body: JSON.stringify({
        target_type: 'chat_message',
        target_id: message.id,
        category: 'harassment',
        detail: '刷屏骂人',
      }),
    });
    expect(report.report_id).toBeTruthy();
    expect(report.status).toBe('pending');

    const pending = await jsonFetch(harness.baseUrl, '/api/v1/admin/reports?status=pending', { headers: ADMIN });
    expect(pending.some((row: any) => row.id === report.report_id)).toBe(true);

    const resolved = await jsonFetch(harness.baseUrl, `/api/v1/admin/reports/${report.report_id}/resolve`, {
      method: 'POST',
      headers: ADMIN,
      body: JSON.stringify({ action: 'mute', actor: 'gm-test' }),
    });
    expect(resolved.report.status).toBe('resolved');
    expect(resolved.outcome.status).toBe('muted');

    const blocked = waitFor(socketB, 'error', undefined, 8000);
    socketB.emit('chat', { channel_id: FIXED_IDS.SEA_CHANNEL, text: '还能说话吗' });
    const err = await blocked;
    expect(String(err.text ?? err.message)).toContain('禁言');
  });
});


