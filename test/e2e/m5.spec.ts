import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Socket } from 'socket.io-client';
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

describe('M5 内测准备（e2e）', () => {
  let harness: Harness;
  let socket: Socket;

  beforeAll(async () => {
    harness = await createHarness();
    const created = await loginAndCreateCharacter(harness.baseUrl, '内测员', '试航');
    socket = await connectSocket(harness.port);
    await authSocket(socket, created.token, created.character.id);
  }, 40000);

  afterAll(async () => {
    await closeHarness(harness, [socket]);
  });

  it('「反馈 …」写入反馈表，后台能查、能关闭', async () => {
    const ack = waitFor(socket, 'narration', (p) => p.text.includes('记下了'), 8000);
    socket.emit('chat', { channel_id: FIXED_IDS.SEA_CHANNEL, text: '反馈 漂流时偶遇岛屿太慢' });
    await ack;

    const list = await jsonFetch(harness.baseUrl, '/api/v1/admin/feedback?status=new', { headers: ADMIN });
    const row = list.find((item: any) => item.content.includes('太慢'));
    expect(row).toBeTruthy();

    const closed = await jsonFetch(harness.baseUrl, `/api/v1/admin/feedback/${row.id}/close`, {
      method: 'POST',
      headers: ADMIN,
      body: JSON.stringify({ actor: 'gm-test' }),
    });
    expect(closed.status).toBe('closed');
  });

  it('内测指标与内容安全报告可读', async () => {
    const metrics = await jsonFetch(harness.baseUrl, '/api/v1/admin/metrics', { headers: ADMIN });
    expect(metrics.players.total).toBeGreaterThan(0);
    expect(metrics.players.online).toBeGreaterThanOrEqual(0);
    expect(metrics.combat).toHaveProperty('completion_rate');
    expect(metrics.travel).toHaveProperty('encounter_rate');
    expect(metrics.ai.budget_per_user).toBeGreaterThan(0);

    const safety = await jsonFetch(harness.baseUrl, '/api/v1/admin/safety-report?days=7', { headers: ADMIN });
    expect(safety.window_days).toBe(7);
    expect(safety).toHaveProperty('by_category');
    expect(safety.reports).toHaveProperty('pending');
  });
});
