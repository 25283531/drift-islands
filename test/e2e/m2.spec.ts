import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { Character, Ship } from '../../src/database/entities/character.entities';
import { Island, Monster } from '../../src/database/entities/island.entities';
import { Item, Crystal } from '../../src/database/entities/item.entities';
import {
  closeHarness,
  connectSocket,
  createHarness,
  Harness,
  jsonFetch,
  loginAndCreateCharacter,
  waitFor,
} from './helpers';

const ANSWERS: Record<string, string> = {
  name: '碎桅岛',
  description: '一座被风暴折断桅杆的旧渔港，浅滩上停着半沉的拖网船。',
  rules: '夜里不要靠近灯塔；岛上的淡水由岛主统一分配；损坏的渔网可以拆成绳子',
  resources: '旧渔港：多食物与零件，少量燃料',
  monsters: '拾荒者',
  max_level: '1',
  count: '2',
  concentrated: '分散',
  point_name: '',
  buildings: '鱼市、灯塔',
  defenses: '铁丝网',
  weapons: '鱼叉炮',
};

describe('M2 验收：造岛 / 收集裁决 / 船只升级 / 晶核 / 驻扎 / 岛主面板', () => {
  let harness: Harness;
  let token: string;
  let character: any;
  let ship: any;
  let socket: any;
  let ds: DataSource;

  beforeAll(async () => {
    harness = await createHarness();
    ds = harness.app.get(DataSource);
    const created = await loginAndCreateCharacter(harness.baseUrl, 'M2船长', '试航者');
    token = created.token;
    character = created.character;
    ship = created.ship;
    socket = await connectSocket(harness.port);
    const authenticated = waitFor(socket, 'authenticated');
    socket.emit('auth', { token, character_id: character.id });
    await authenticated;
  });

  afterAll(async () => {
    await closeHarness(harness, [socket]);
  });

  it('模板问答生成岛屿定义，创建后不返回坐标', async () => {
    const started = waitFor(socket, 'island_create_question');
    socket.emit('island_create_start');
    let question = await started;

    for (let i = 0; i < 20; i += 1) {
      const id = question.question_id as string;
      const answer = ANSWERS[id] ?? '';
      const nextQuestion = waitFor(socket, 'island_create_question', undefined, 4000).catch(() => null);
      const summary = waitFor(socket, 'island_create_summary', undefined, 2500).catch(() => null);
      socket.emit('island_create_answer', { question_id: id, answer });
      const [next, summarized] = await Promise.all([nextQuestion, summary]);
      if (summarized) {
        expect(summarized.issues).toEqual([]);
        expect(summarized.draft.name).toBe('碎桅岛');
        expect(summarized.draft.rules.length).toBe(3);
        break;
      }
      question = next;
      if (!question) break;
    }

    const created = waitFor(socket, 'island_created');
    socket.emit('island_create_confirm');
    const islandCreated = await created;
    expect(islandCreated.island_id).toBeTruthy();
    expect(JSON.stringify(islandCreated)).not.toContain('"x"');

    const island = await ds.getRepository(Island).findOne({ where: { id: islandCreated.island_id } });
    expect(island).toBeTruthy();
    expect(island!.creator_user_id).toBe(character.user_id);
    expect(Math.hypot(island!.x, island!.y)).toBeGreaterThanOrEqual(10);
    expect(island!.threat_used).toBe(6);
    expect(island!.max_monster_level).toBe(1);

    // 创建者面板可看统计，但看不到坐标
    const panel = await jsonFetch(harness.baseUrl, `/api/v1/islands/${island!.id}/panel`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(panel.visit_count).toBe(0);
    expect(panel.defense_power).toBeGreaterThan(0);
    expect(panel).not.toHaveProperty('x');
    expect(panel).not.toHaveProperty('y');
  });

  it('进岛收集：数字判定决定成败与数量，失败不会被 AI 改写', async () => {
    const island = await ds.getRepository(Island).findOne({ where: { creator_user_id: character.user_id } });
    expect(island).toBeTruthy();

    // 清掉岛上的怪，避免进岛即战斗
    await ds.getRepository(Monster).update({ island_id: island!.id }, { state: 'dead', hp: 0 });

    // 白盒把角色放到岛上（坐标本身对玩家不可见）
    const repo = ds.getRepository(Character);
    const row = (await repo.findOne({ where: { id: character.id } }))!;
    row.x = island!.x;
    row.y = island!.y;
    await repo.save(row);

    const channelChanged = waitFor(socket, 'channel_changed');
    socket.emit('enter_island', { island_id: island!.id });
    const changed = await channelChanged;
    expect(changed.island_id).toBe(island!.id);

    let result: any = null;
    for (let attempt = 0; attempt < 6 && !result; attempt += 1) {
      const pending = waitFor(socket, 'arbitration_result', undefined, 5000);
      socket.emit('collect', { intent: '燃料' });
      const payload = await pending;
      if (payload.outcome === 'success') result = payload;
      else {
        expect(payload.amount).toBe(0);
        expect(payload.narration).toBeTruthy();
      }
    }
    expect(result).toBeTruthy();
    expect(result.chance).toBeGreaterThanOrEqual(0.15);
    expect(result.chance).toBeLessThanOrEqual(0.9);
    expect(result.amount).toBeGreaterThanOrEqual(1);
    expect(result.items[0].type).toBe('fuel');

    const carried = await ds.getRepository(Item).findOne({
      where: { owner_type: 'character', owner_id: character.id, type: 'fuel' },
    });
    expect(carried?.quantity ?? 0).toBeGreaterThanOrEqual(1);
    const islandRow = await ds.getRepository(Island).findOne({ where: { id: island!.id } });
    expect(islandRow!.resources_taken).toBeGreaterThanOrEqual(1);
  });

  it('船只四条线升级：扣料并生效', async () => {
    await ds.getRepository(Item).save(
      ds.getRepository(Item).create([
        { id: randomUUID(), name: '零件', type: 'part', quantity: 10, owner_type: 'character', owner_id: character.id, tags: [], condition: null, x: 0, y: 0 },
        { id: randomUUID(), name: '燃料', type: 'fuel', quantity: 5, owner_type: 'character', owner_id: character.id, tags: [], condition: null, x: 0, y: 0 },
      ]),
    );

    const res = await jsonFetch(harness.baseUrl, `/api/v1/ships/${ship.id}/upgrade`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ track: 'defense' }),
    });
    expect(res.error).toBeUndefined();
    expect(res.ship.defense_lv).toBe(1);
    expect(res.ship.max_durability).toBe(115);
    expect(res.spent.part).toBe(2);

    const after = await ds.getRepository(Ship).findOne({ where: { id: ship.id } });
    expect(after!.defense_lv).toBe(1);

    // 材料不足时拒绝
    const failing = await jsonFetch(harness.baseUrl, `/api/v1/ships/${ship.id}/upgrade`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ track: 'living' }),
    });
    expect(failing.message ?? failing.error?.message ?? '').toContain('升级需要');
  });

  it('晶核：吸收能量并升级，剩余能量留在晶体中', async () => {
    const crystal = await ds.getRepository(Crystal).save(
      ds.getRepository(Crystal).create({
        id: randomUUID(),
        level: 2,
        energy_total: 100,
        energy_remaining: 100,
        holder_type: 'character',
        holder_id: character.id,
        x: null,
        y: null,
      }),
    );

    const absorbed = waitFor(socket, 'crystal_absorbed', undefined, 5000);
    socket.emit('crystal_absorb', { crystal_id: crystal.id });
    const result = await absorbed;

    expect(result.level_after).toBe(1);
    expect(result.gained).toBeCloseTo(0.1, 4);
    expect(result.remaining_in_crystal).toBeCloseTo(99.9, 3);

    const left = await ds.getRepository(Crystal).findOne({ where: { id: crystal.id } });
    expect(left).toBeTruthy();
  });

  it('驻扎建基地，岛主面板数据随访问更新', async () => {
    const island = await ds.getRepository(Island).findOne({ where: { creator_user_id: character.user_id } });

    const base = waitFor(socket, 'base_update', undefined, 5000);
    socket.emit('settle', { island_id: island!.id });
    const settled = await base;
    expect(settled.base.defense_lv).toBe(1);

    const islandRow = await ds.getRepository(Island).findOne({ where: { id: island!.id } });
    expect(islandRow!.owner_character_id).toBe(character.id);
    expect(islandRow!.visit_count).toBeGreaterThanOrEqual(1);

    const panel = await jsonFetch(harness.baseUrl, `/api/v1/islands/${island!.id}/panel`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(panel.visit_count).toBeGreaterThanOrEqual(1);
    expect(panel.resources_taken).toBeGreaterThanOrEqual(1);
    expect(panel.base.defense_lv).toBe(1);
    expect(panel).not.toHaveProperty('x');
  });
});
