import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Socket } from 'socket.io-client';
import { FIXED_IDS } from '../../src/database/seed.service';
import { Harness, authSocket, closeHarness, connectSocket, createHarness, loginAndCreateCharacter, waitFor } from './helpers';

describe('聊天室文字驱动（e2e）', () => {
  let harness: Harness;
  let socket: Socket;
  let character: any;

  beforeAll(async () => {
    harness = await createHarness();
    const created = await loginAndCreateCharacter(harness.baseUrl, '文字玩家', '阿舵');
    character = created.character;
    socket = await connectSocket(harness.port);
    await authSocket(socket, created.token, character.id);
  }, 40000);

  afterAll(async () => {
    await closeHarness(harness, [socket]);
  });

  it('「菜单」返回可用操作', async () => {
    const reply = waitFor(socket, 'narration', (p) => p.text.includes('启航'), 8000);
    socket.emit('chat', { channel_id: FIXED_IDS.SEA_CHANNEL, text: '菜单' });
    const text = (await reply).text;
    expect(text).toContain('造岛');
    expect(text).toContain('攻击');
  });

  it('「启航」→ 方向 → 航程 完成一次航行', async () => {
    const askDirection = waitFor(socket, 'narration', (p) => p.text.includes('哪个方向'), 8000);
    socket.emit('chat', { channel_id: FIXED_IDS.SEA_CHANNEL, text: '启航' });
    await askDirection;

    const askDistance = waitFor(socket, 'narration', (p) => p.text.includes('航程'), 8000);
    socket.emit('chat', { channel_id: FIXED_IDS.SEA_CHANNEL, text: '45' });
    await askDistance;

    const sailed = waitFor(socket, 'narration', (p) => p.text.includes('航行'), 12000);
    const positionPromise = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('没有收到位置更新')), 5000);
      socket.once('position', (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
    socket.emit('chat', { channel_id: FIXED_IDS.SEA_CHANNEL, text: '2' });
    await sailed;

    const position = await positionPromise;
    expect(Math.hypot(position.x, position.y)).toBeGreaterThan(0.5);
  });

  it('「造岛」后一段话只追问缺失项', async () => {
    const prompt = waitFor(socket, 'narration', (p) => p.text.includes('一段话'), 8000);
    socket.emit('chat', { channel_id: FIXED_IDS.SEA_CHANNEL, text: '造岛' });
    await prompt;

    const followUp = waitFor(socket, 'narration', (p) => p.text.includes('还差') || p.text.includes('岛名'), 15000);
    socket.emit('chat', { channel_id: FIXED_IDS.SEA_CHANNEL, text: '一座有很多药的岛' });
    const text = (await followUp).text;
    expect(text.length).toBeGreaterThan(4);

    const cancelled = waitFor(socket, 'narration', (p) => p.text.includes('先不做'), 8000);
    socket.emit('chat', { channel_id: FIXED_IDS.SEA_CHANNEL, text: '取消' });
    await cancelled;
  });
});
