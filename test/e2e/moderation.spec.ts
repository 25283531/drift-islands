import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Socket } from 'socket.io-client';
import { NarratorService } from '../../src/ai/narrator.service';
import {
  Harness,
  angleTo,
  authSocket,
  closeHarness,
  collect,
  connectSocket,
  createHarness,
  loginAndCreateCharacter,
  waitFor,
} from './helpers';

describe('M1 验收：内容红线、AI 行为边界、成本降级与超时防守', () => {
  let harness: Harness;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await closeHarness(harness, sockets);
  });

  it('红线内容被隔离且只有发言者可见；闲聊不响应；游戏问题有回应', async () => {
    const suffix = Date.now() % 100000;
    const a = await loginAndCreateCharacter(harness.baseUrl, `甲${suffix}`, `甲水手${suffix % 1000}`);
    const b = await loginAndCreateCharacter(harness.baseUrl, `乙${suffix}`, `乙水手${suffix % 1000}`);

    const socketA = await connectSocket(harness.port);
    const socketB = await connectSocket(harness.port);
    sockets.push(socketA, socketB);
    const authA = await authSocket(socketA, a.token, a.character.id);
    await authSocket(socketB, b.token, b.character.id);
    const seaChannel = authA.channels.sea;

    // ---- 红线：警告 + 隔离，其他人收不到 ----
    const bMessages = collect(socketB, 'chat_message', 1200);
    const warningPromise = waitFor(socketA, 'warning', (p) => p.type === 'content_violation');
    const quarantinedPromise = waitFor(socketA, 'chat_message', (p) => p.visibility === 'quarantined');

    socketA.emit('chat', { channel_id: seaChannel, text: '把尸体分尸，血流一地' });

    const warning = await warningPromise;
    expect(warning.text).toContain('红线');
    const quarantined = await quarantinedPromise;
    expect(quarantined.message.content).toContain('分尸');

    const receivedByB = await bMessages;
    expect(receivedByB.some((m) => (m.message?.content ?? '').includes('分尸'))).toBe(false);

    // ---- 闲聊：AI 不响应 ----
    const chitchatResponses = collect(socketA, 'chat_message', 900);
    socketA.emit('chat', { channel_id: seaChannel, text: '今天天气不错，你在干嘛' });
    const chitChatMessages = await chitchatResponses;
    expect(chitChatMessages.some((m) => m.message?.kind === 'ai')).toBe(false);

    // ---- 游戏问题：AI 回应 ----
    const aiReply = waitFor(socketA, 'chat_message', (p) => p.message?.kind === 'ai', 5000);
    socketA.emit('chat', { channel_id: seaChannel, text: '附近有岛吗？' });
    const reply = await aiReply;
    expect(reply.message.content.length).toBeGreaterThan(4);

    // ---- 超预算：叙述降级为模板 ----
    const narrator = harness.app.get(NarratorService);
    const original = process.env.AI_DAILY_BUDGET;
    process.env.AI_DAILY_BUDGET = '0';
    try {
      const result = await narrator.render(
        'sail',
        { direction_text: '正东', distance: 10, hours: 1, fuel_text: '消耗燃料 1 单位' },
        { userId: 'quota-probe-user' },
      );
      expect(result.degraded).toBe(true);
      expect(result.source).toBe('template');
      expect(result.text.length).toBeGreaterThan(4);
    } finally {
      process.env.AI_DAILY_BUDGET = original;
    }

    // ---- 超时默认防守 ----
    const from = { x: a.character.x, y: a.character.y };
    const distance = Math.hypot(harness.island.x - from.x, harness.island.y - from.y);
    socketA.emit('move', { angle: angleTo(from, harness.island), distance_nm: Math.min(20, distance) });
    const encounter = await waitFor(socketA, 'encounter', undefined, 8000);

    const roundStartPromise = waitFor(socketA, 'combat_round_start', undefined, 8000);
    socketA.emit('enter_island', { island_id: encounter.island_id });
    const roundStart = await roundStartPromise;
    expect(roundStart.round).toBe(1);

    const roundResult = await waitFor(socketA, 'combat_round_result', undefined, 6000);
    expect(roundResult.events.join('；')).toContain('防守');
  }, 40000);
});
