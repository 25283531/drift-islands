import { Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { AuthService } from '../auth/auth.service';
import { CharactersService } from '../characters/characters.service';
import { IslandsService } from '../islands/islands.service';
import { MovementService } from '../movement/movement.service';
import { CombatService } from '../combat/combat.service';
import { ChatService } from '../chat/chat.service';
import { NarratorService } from '../ai/narrator.service';
import { WorldService } from '../world/world.service';
import { IslandCreateService } from '../islands/island-create.service';
import { CollectService } from '../collect/collect.service';
import { CrystalsService } from '../crystals/crystals.service';
import { GarrisonService } from '../garrison/garrison.service';
import { ShipsService } from '../ships/ships.service';
import { TeamService, TradeService } from '../m3/social.service';
import { ConflictService } from '../m3/conflict.service';
import { FatigueService, ProtectionService, SkillsService } from '../m3/growth.service';
import { MonsterAiService } from '../m3/monster-ai.service';
import { FIXED_IDS } from '../database/seed.service';
import { GAME } from '../game/constants';
import { envInt } from '../common/env';
import { MENU_TEXT, parseDirection, parseDistance, parseIntent } from '../game/commands';
import { bearingDeg, bearingText, round1 } from '../game/geo';
interface SocketIdentity {
  userId: string;
  characterId: string;
}

@WebSocketGateway({ cors: { origin: '*' } })
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(GameGateway.name);
  @WebSocketServer() server: Server;

  private readonly sockets = new Map<string, Socket>();
  private readonly graceTimers = new Map<string, NodeJS.Timeout>();
  private readonly commandStates = new Map<string, { mode: 'sail_direction' | 'sail_distance' | 'island_text' | 'island_fill' | 'confirm_island'; angle?: number }>();

  constructor(
    private readonly auth: AuthService,
    private readonly characters: CharactersService,
    private readonly islands: IslandsService,
    private readonly movement: MovementService,
    private readonly combat: CombatService,
    private readonly chat: ChatService,
    private readonly narrator: NarratorService,
    private readonly world: WorldService,
    private readonly islandCreate: IslandCreateService,
    private readonly collectService: CollectService,
    private readonly crystals: CrystalsService,
    private readonly garrison: GarrisonService,
    private readonly ships: ShipsService,
    private readonly team: TeamService,
    private readonly trade: TradeService,
    private readonly conflict: ConflictService,
    private readonly skills: SkillsService,
    private readonly fatigue: FatigueService,
    private readonly protection: ProtectionService,
    private readonly monsterAi: MonsterAiService,
  ) {}

  handleConnection(client: Socket): void {
    this.logger.debug(`socket connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    const identity = client.data as SocketIdentity;
    if (!identity?.characterId) return;
    this.sockets.delete(identity.characterId);

    const runtime = this.combat.activeFor(identity.characterId);
    if (runtime) {
      // 战斗中不可下线：人物留在原地，宽限期满也不隐身（§3）
      this.logger.debug(`战斗中掉线，保持 in_combat：${identity.characterId}`);
      return;
    }

    void this.characters.setStatus(identity.characterId, 'grace');
    this.emitCharacterUpdate(identity.characterId);

    const timer = setTimeout(async () => {
      const stillOffline = !this.sockets.has(identity.characterId);
      if (!stillOffline) return;
      const character = await this.characters.get(identity.characterId);
      if (!character || character.status === 'in_combat') return;
      await this.characters.setStatus(identity.characterId, 'offline');
      this.emitCharacterUpdate(identity.characterId);
    }, GAME.DISCONNECT_GRACE_MS);
    timer.unref?.();
    this.graceTimers.set(identity.characterId, timer);
  }

  // ---------------------------------------------------------------- auth

  @SubscribeMessage('auth')
  async onAuth(@ConnectedSocket() client: Socket, @MessageBody() body: { token?: string; character_id?: string }) {
    try {
      if (!body?.token) return this.emitError(client, 'AUTH_REQUIRED', '缺少会话 token');
      const payload = await this.auth.verify(body.token);

      const character = body.character_id
        ? await this.characters.get(body.character_id)
        : await this.characters.getForUser(payload.sub);
      if (!character || character.user_id !== payload.sub) {
        return this.emitError(client, 'NO_CHARACTER', '请先创建角色');
      }

      client.data = { userId: payload.sub, characterId: character.id } satisfies SocketIdentity;
      this.sockets.set(character.id, client);
      const grace = this.graceTimers.get(character.id);
      if (grace) {
        clearTimeout(grace);
        this.graceTimers.delete(character.id);
      }

      await this.characters.setStatus(character.id, 'online');
      const ship = await this.characters.getShip(character.ship_id);
      const islandChannel = character.island_id ? await this.islands.channelOf(character.island_id) : null;

      client.join(`channel:${FIXED_IDS.SEA_CHANNEL}`);
      let activeChannel: string = FIXED_IDS.SEA_CHANNEL;
      if (character.island_id && islandChannel) {
        client.join(`channel:${islandChannel.id}`);
        activeChannel = islandChannel.id;
      }

      const fresh = await this.characters.get(character.id);
      client.emit('authenticated', {
        character: fresh,
        ship,
        channels: {
          sea: FIXED_IDS.SEA_CHANNEL,
          island: islandChannel?.id ?? null,
          active: activeChannel,
        },
      });
      client.emit('character_update', { character: fresh });
      client.emit('ship_update', { ship });

      const state = await this.world.getState();
      client.emit('position', this.positionPayload(fresh, ship, state));
      client.emit('world_tick', {
        world_day: state.world_day,
        world_hour: Math.floor(state.world_minutes / 60),
        day_night: this.world.isNight(state.world_minutes) ? 'night' : 'day',
        current: state.current_direction,
      });

      const history = await this.chat.recent(activeChannel, 40);
      client.emit('chat_history', { channel_id: activeChannel, messages: history });

      if (fresh.island_id) {
        const runtime = this.combat.activeFor(fresh.id);
        if (runtime) {
          client.emit('combat_round_start', {
            combat_id: runtime.id,
            round: runtime.round,
            deadline_ms: this.combat.roundMs,
            participants: runtime.participants.map((p) => ({
              id: p.id,
              side: p.side,
              name: p.name,
              hp: p.hp,
              max_hp: p.maxHp,
              speed: p.speed,
              level: p.level,
            })),
          });
        }
      }
      return { ok: true };
    } catch (err) {
      this.emitError(client, 'AUTH_FAILED', (err as Error).message || '会话无效');
      return { ok: false };
    }
  }

  // ---------------------------------------------------------------- movement

  @SubscribeMessage('move')
  async onMove(@ConnectedSocket() client: Socket, @MessageBody() body: { angle?: number; distance_nm?: number }) {
    const identity = this.identity(client);
    if (!identity) return;
    try {
      const result = await this.movement.move(identity.characterId, Number(body?.angle ?? 0), Number(body?.distance_nm ?? 0));
      await this.afterTravel(client, result);
    } catch (err) {
      this.emitError(client, 'MOVE_FAILED', (err as Error).message);
    }
  }

  @SubscribeMessage('drift')
  async onDrift(@ConnectedSocket() client: Socket) {
    const identity = this.identity(client);
    if (!identity) return;
    try {
      const result = await this.movement.drift(identity.characterId);
      await this.afterTravel(client, result);
    } catch (err) {
      this.emitError(client, 'DRIFT_FAILED', (err as Error).message);
    }
  }

  private async afterTravel(client: Socket, result: Awaited<ReturnType<MovementService['move']>>): Promise<void> {
    if (result.refused) {
      this.emitError(client, 'TRAVEL_REFUSED', result.refused);
      return;
    }
    const state = await this.world.getState();
    client.emit('position', this.positionPayload(result.character, result.ship, state));
    client.emit('narration', {
      channel_id: FIXED_IDS.SEA_CHANNEL,
      text: result.narration.text,
      kind: 'sail',
      degraded: result.narration.degraded,
    });
    client.emit('character_update', { character: result.character });
    client.emit('ship_update', { ship: result.ship });

    for (const warning of result.warnings) {
      client.emit('warning', warning);
    }
    if (result.encounter) {
      client.emit('encounter', {
        island_id: result.encounter.island.id,
        name: result.encounter.island.name,
        distance_nm: Math.round(result.encounter.distance * 10) / 10,
        hint: result.encounter.hint,
      });
      if (result.encounter_narration) {
        client.emit('narration', {
          channel_id: FIXED_IDS.SEA_CHANNEL,
          text: result.encounter_narration.text,
          kind: 'encounter',
          degraded: result.encounter_narration.degraded,
        });
      }
    }
  }

  // ---------------------------------------------------------------- island

  @SubscribeMessage('enter_island')
  async onEnterIsland(@ConnectedSocket() client: Socket, @MessageBody() body: { island_id?: string }) {
    const identity = this.identity(client);
    if (!identity) return;
    if (!body?.island_id) return this.emitError(client, 'BAD_REQUEST', '缺少 island_id');

    const character = await this.characters.get(identity.characterId);
    if (!character) return this.emitError(client, 'NO_CHARACTER', '角色不存在');
    if (this.combat.activeFor(character.id)) return this.emitError(client, 'ALREADY_IN_COMBAT', '你已经在战斗里');

    const result = await this.islands.enter(character, body.island_id);
    if ('error' in result) return this.emitError(client, 'ENTER_ISLAND_FAILED', result.error);

    await this.characters.save(character);
    const ship = await this.characters.getShip(character.ship_id);

    client.leave(`channel:${FIXED_IDS.SEA_CHANNEL}`);
    client.join(`channel:${result.channel.id}`);

    const monsterText = result.monsters.length
      ? `岸上有 ${result.monsters.length} 个活物：${result.monsters.map((m) => m.custom_name ?? `怪物 Lv.${m.level}`).join('、')}。`
      : '岸上暂时没有活物。';

    const narration = await this.narrator.render(
      'enter_island',
      { name: result.island.name, description: result.island.description, monster_text: monsterText },
      { userId: character.user_id, cacheKey: `island:${result.island.id}` },
    );

    client.emit('narration', {
      channel_id: result.channel.id,
      text: narration.text,
      kind: 'enter_island',
      degraded: narration.degraded,
    });
    for (const warning of result.warnings) client.emit('warning', warning);
    client.emit('character_update', { character });
    client.emit('ship_update', { ship });
    client.emit('channel_changed', { channel_id: result.channel.id, island_id: result.island.id });

    const history = await this.chat.recent(result.channel.id, 40);
    client.emit('chat_history', { channel_id: result.channel.id, messages: history });

    if (result.monsters.length > 0 && ship) {
      await this.combat.startCombat({
        character,
        ship,
        islandId: result.island.id,
        channelId: result.channel.id,
        monsters: result.monsters,
      });
    }
  }

  @SubscribeMessage('leave_island')
  async onLeaveIsland(@ConnectedSocket() client: Socket) {
    const identity = this.identity(client);
    if (!identity) return;
    const character = await this.characters.get(identity.characterId);
    if (!character) return this.emitError(client, 'NO_CHARACTER', '角色不存在');
    if (this.combat.activeFor(character.id)) {
      return this.emitError(client, 'COMBAT_LOCK', '战斗中不能离岛');
    }
    if (!character.island_id) return this.emitError(client, 'NOT_ON_ISLAND', '你不在岛上');

    const island = await this.islands.get(character.island_id);
    const islandChannel = character.island_id ? await this.islands.channelOf(character.island_id) : null;
    character.island_id = null;
    await this.characters.save(character);

    if (islandChannel) client.leave(`channel:${islandChannel.id}`);
    client.join(`channel:${FIXED_IDS.SEA_CHANNEL}`);

    const narration = await this.narrator.render(
      'leave_island',
      { name: island?.name ?? '这座岛' },
      { userId: character.user_id },
    );

    client.emit('narration', {
      channel_id: FIXED_IDS.SEA_CHANNEL,
      text: narration.text,
      kind: 'leave_island',
      degraded: narration.degraded,
    });
    client.emit('character_update', { character });
    client.emit('channel_changed', { channel_id: FIXED_IDS.SEA_CHANNEL, island_id: null });
  }

  // ---------------------------------------------------------------- chat

  @SubscribeMessage('chat')
  async onChat(@ConnectedSocket() client: Socket, @MessageBody() body: { channel_id?: string; text?: string }) {
    const identity = this.identity(client);
    if (!identity) return;
    const character = await this.characters.get(identity.characterId);
    if (!character) return this.emitError(client, 'NO_CHARACTER', '角色不存在');

    const channelId = body?.channel_id || FIXED_IDS.SEA_CHANNEL;
    const text = (body?.text ?? '').trim();
    if (text && (await this.handleTextCommand(client, character, text))) return;

    const result = await this.chat.send({
      characterId: character.id,
      userId: identity.userId,
      channelId,
      text: body?.text ?? '',
      islandId: character.island_id,
    });

    if (!result.ok) return this.emitError(client, 'CHAT_REJECTED', result.error);

    if (result.quarantined) {
      // 隔离：只回给发言者本人
      client.emit('chat_message', {
        channel_id: channelId,
        message: result.message,
        visibility: 'quarantined',
      });
      if (result.warning) client.emit('warning', result.warning);
      return;
    }

    this.server.to(`channel:${channelId}`).emit('chat_message', {
      channel_id: channelId,
      message: result.message,
      visibility: 'visible',
    });

    if (result.aiReply) {
      const ai = await this.chat.aiMessage(channelId, result.aiReply);
      this.server.to(`channel:${channelId}`).emit('chat_message', {
        channel_id: channelId,
        message: ai,
        visibility: 'visible',
      });
    }
  }

  // ---------------------------------------------------------------- M2 造岛 / 收集 / 晶核 / 驻扎

  @SubscribeMessage('island_create_start')
  async onIslandCreateStart(@ConnectedSocket() client: Socket) {
    const identity = this.identity(client);
    if (!identity) return;
    try {
      const started = this.islandCreate.start(identity.characterId);
      client.emit('island_create_question', {
        question_id: started.question.id,
        text: started.question.text,
        options: started.question.options ?? null,
        index: started.index,
        total: started.total,
      });
    } catch (err) {
      this.emitError(client, 'ISLAND_CREATE_FAILED', (err as Error).message);
    }
  }

  @SubscribeMessage('island_create_answer')
  async onIslandCreateAnswer(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { question_id?: string; answer?: string | null },
  ) {
    const identity = this.identity(client);
    if (!identity) return;
    try {
      const result = this.islandCreate.answer(identity.characterId, body?.question_id ?? '', body?.answer ?? null);
      if (result.next) {
        client.emit('island_create_question', {
          question_id: result.next.id,
          text: result.next.text,
          options: result.next.options ?? null,
        });
      } else {
        const summary = await this.islandCreate.summary(identity.characterId);
        client.emit('island_create_summary', summary);
      }
    } catch (err) {
      this.emitError(client, 'ISLAND_CREATE_FAILED', (err as Error).message);
    }
  }

  @SubscribeMessage('island_create_confirm')
  async onIslandCreateConfirm(@ConnectedSocket() client: Socket) {
    const identity = this.identity(client);
    if (!identity) return;
    const character = await this.characters.get(identity.characterId);
    if (!character) return this.emitError(client, 'NO_CHARACTER', '角色不存在');
    try {
      const result = await this.islandCreate.confirm(character);
      client.emit('island_created', { island_id: result.island.id, name: result.island.name, summary: result.summary });
      for (const warning of result.warnings) client.emit('warning', { type: 'island_create', text: warning });
    } catch (err) {
      this.emitError(client, 'ISLAND_CREATE_FAILED', (err as Error).message);
    }
  }

  @SubscribeMessage('island_create_cancel')
  onIslandCreateCancel(@ConnectedSocket() client: Socket) {
    const identity = this.identity(client);
    if (!identity) return;
    this.islandCreate.cancel(identity.characterId);
    client.emit('narration', { channel_id: FIXED_IDS.SEA_CHANNEL, text: '你把画到一半的岛图揉成一团，丢进海里。', kind: 'island_create' });
  }

  @SubscribeMessage('collect')
  async onCollect(@ConnectedSocket() client: Socket, @MessageBody() body: { intent?: string; island_id?: string }) {
    const identity = this.identity(client);
    if (!identity) return;
    const character = await this.characters.get(identity.characterId);
    if (!character) return this.emitError(client, 'NO_CHARACTER', '角色不存在');
    if (this.combat.activeFor(character.id)) return this.emitError(client, 'COMBAT_LOCK', '战斗中不能搜刮');
    const islandId = body?.island_id || character.island_id;
    if (!islandId) return this.emitError(client, 'NOT_ON_ISLAND', '你不在岛上');
    try {
      const result = await this.collectService.collect(character, islandId, body?.intent ?? '');
      client.emit('arbitration_result', {
        kind: 'collect',
        outcome: result.outcome,
        category: result.category,
        amount: result.amount,
        chance: result.chance,
        roll: result.roll,
        narration: result.narration,
        items: result.items ?? [],
      });
      this.emitCharacterUpdate(character.id);
    } catch (err) {
      this.emitError(client, 'COLLECT_FAILED', (err as Error).message);
    }
  }

  @SubscribeMessage('crystal_absorb')
  async onCrystalAbsorb(@ConnectedSocket() client: Socket, @MessageBody() body: { crystal_id?: string }) {
    const identity = this.identity(client);
    if (!identity) return;
    const character = await this.characters.get(identity.characterId);
    if (!character) return this.emitError(client, 'NO_CHARACTER', '角色不存在');
    try {
      const result = await this.crystals.absorb(character, body?.crystal_id ?? '');
      client.emit('crystal_absorbed', result);
      client.emit('narration', { channel_id: FIXED_IDS.SEA_CHANNEL, text: result.narration, kind: 'crystal' });
      this.emitCharacterUpdate(character.id);
      client.emit('crystals', { items: await this.crystals.list(character.id) });
    } catch (err) {
      this.emitError(client, 'CRYSTAL_ABSORB_FAILED', (err as Error).message);
    }
  }

  @SubscribeMessage('crystals')
  async onCrystals(@ConnectedSocket() client: Socket) {
    const identity = this.identity(client);
    if (!identity) return;
    client.emit('crystals', { items: await this.crystals.list(identity.characterId) });
  }

  @SubscribeMessage('settle')
  async onSettle(@ConnectedSocket() client: Socket, @MessageBody() body: { island_id?: string }) {
    const identity = this.identity(client);
    if (!identity) return;
    const character = await this.characters.get(identity.characterId);
    if (!character) return this.emitError(client, 'NO_CHARACTER', '角色不存在');
    try {
      const result = await this.garrison.settle(character, body?.island_id || character.island_id || '');
      client.emit('base_update', result);
      client.emit('narration', { channel_id: character.island_id ?? FIXED_IDS.SEA_CHANNEL, text: result.narration, kind: 'settle' });
    } catch (err) {
      this.emitError(client, 'SETTLE_FAILED', (err as Error).message);
    }
  }

  @SubscribeMessage('base_build')
  async onBaseBuild(@ConnectedSocket() client: Socket, @MessageBody() body: { island_id?: string; facility?: string }) {
    const identity = this.identity(client);
    if (!identity) return;
    const character = await this.characters.get(identity.characterId);
    if (!character) return this.emitError(client, 'NO_CHARACTER', '角色不存在');
    try {
      const result = await this.garrison.build(character, body?.island_id || character.island_id || '', body?.facility ?? '');
      client.emit('base_update', result);
      client.emit('narration', { channel_id: character.island_id ?? FIXED_IDS.SEA_CHANNEL, text: result.narration, kind: 'base' });
    } catch (err) {
      this.emitError(client, 'BASE_BUILD_FAILED', (err as Error).message);
    }
  }

  @SubscribeMessage('base_store')
  async onBaseStore(@ConnectedSocket() client: Socket, @MessageBody() body: { island_id?: string; type?: string; quantity?: number }) {
    const identity = this.identity(client);
    if (!identity) return;
    const character = await this.characters.get(identity.characterId);
    if (!character) return this.emitError(client, 'NO_CHARACTER', '角色不存在');
    try {
      const result = await this.garrison.store(character, body?.island_id || character.island_id || '', body?.type ?? '', Number(body?.quantity ?? 1));
      client.emit('base_update', { ...result, storage: await this.garrison.storage(body?.island_id || character.island_id || '') });
    } catch (err) {
      this.emitError(client, 'BASE_STORE_FAILED', (err as Error).message);
    }
  }

  @SubscribeMessage('base_take')
  async onBaseTake(@ConnectedSocket() client: Socket, @MessageBody() body: { island_id?: string; type?: string; quantity?: number }) {
    const identity = this.identity(client);
    if (!identity) return;
    const character = await this.characters.get(identity.characterId);
    if (!character) return this.emitError(client, 'NO_CHARACTER', '角色不存在');
    try {
      const result = await this.garrison.take(character, body?.island_id || character.island_id || '', body?.type ?? '', Number(body?.quantity ?? 1));
      client.emit('base_update', { ...result, storage: await this.garrison.storage(body?.island_id || character.island_id || '') });
    } catch (err) {
      this.emitError(client, 'BASE_TAKE_FAILED', (err as Error).message);
    }
  }

  @SubscribeMessage('ship_upgrade')
  async onShipUpgrade(@ConnectedSocket() client: Socket, @MessageBody() body: { track?: string }) {
    const identity = this.identity(client);
    if (!identity) return;
    const character = await this.characters.get(identity.characterId);
    if (!character) return this.emitError(client, 'NO_CHARACTER', '角色不存在');
    try {
      const result = await this.ships.upgrade(character, body?.track ?? '');
      client.emit('ship_update', { ship: result.ship });
      client.emit('narration', { channel_id: character.island_id ?? FIXED_IDS.SEA_CHANNEL, text: result.narration, kind: 'ship_upgrade' });
      client.emit('character_update', { character: await this.characters.get(character.id) });
    } catch (err) {
      this.emitError(client, 'SHIP_UPGRADE_FAILED', (err as Error).message);
    }
  }

  @SubscribeMessage('island_panel')
  async onIslandPanel(@ConnectedSocket() client: Socket, @MessageBody() body: { island_id?: string }) {
    const identity = this.identity(client);
    if (!identity) return;
    const character = await this.characters.get(identity.characterId);
    if (!character) return this.emitError(client, 'NO_CHARACTER', '角色不存在');
    try {
      const panel = await this.garrison.panel(character, body?.island_id || character.island_id || '');
      client.emit('island_panel', panel);
    } catch (err) {
      this.emitError(client, 'ISLAND_PANEL_FAILED', (err as Error).message);
    }
  }

  // ---------------------------------------------------------------- combat

  @SubscribeMessage('combat_action')
  async onCombatAction(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { combat_id?: string; action?: string; target_id?: string; item_id?: string },
  ) {
    const identity = this.identity(client);
    if (!identity) return;
    if (!body?.combat_id || !body?.action) return this.emitError(client, 'BAD_REQUEST', '缺少战斗指令');

    const result = await this.combat.submitAction(body.combat_id, identity.characterId, {
      action: body.action as any,
      target_id: body.target_id,
      item_id: body.item_id,
    });
    if (!result.ok) this.emitError(client, 'COMBAT_REJECTED', result.message ?? '无法提交行动');
  }

  @SubscribeMessage('logout')
  async onLogout(@ConnectedSocket() client: Socket) {
    const identity = this.identity(client);
    if (identity && this.combat.activeFor(identity.characterId)) {
      return this.emitError(client, 'COMBAT_LOCK', '战斗中不能下线');
    }
    if (identity) {
      await this.characters.setStatus(identity.characterId, 'offline');
      this.emitCharacterUpdate(identity.characterId);
    }
    client.disconnect(true);
  }

  // ---------------------------------------------------------------- M3 团队 / PvP / 交易 / 技能 / 怪物

  private async run<T>(client: Socket, code: string, work: () => Promise<T> | T, event: string, pick?: (value: T) => any) {
    try {
      const value = await work();
      const payload = pick ? await pick(value) : value;
      client.emit(event, payload);
    } catch (err) {
      this.emitError(client, code, (err as Error).message);
    }
  }

  @SubscribeMessage('team_create')
  async onTeamCreate(@ConnectedSocket() client: Socket, @MessageBody() body: { name?: string }) {
    const identity = this.identity(client);
    if (!identity) return;
    await this.run(client, 'TEAM_FAILED', () => this.team.create(identity.characterId, body?.name ?? ''), 'team_update', () => this.team.info(identity.characterId));
  }

  @SubscribeMessage('team_invite')
  async onTeamInvite(@ConnectedSocket() client: Socket, @MessageBody() body: { name?: string }) {
    const identity = this.identity(client);
    if (!identity) return;
    await this.run(
      client,
      'TEAM_FAILED',
      () => this.team.invite(identity.characterId, body?.name ?? ''),
      'team_invited',
      (value) => ({ target: value.target.name, team: value.team.name }),
    );
  }

  @SubscribeMessage('team_join')
  async onTeamJoin(@ConnectedSocket() client: Socket) {
    const identity = this.identity(client);
    if (!identity) return;
    await this.run(client, 'TEAM_FAILED', () => this.team.join(identity.characterId), 'team_update', () => this.team.info(identity.characterId));
  }

  @SubscribeMessage('team_leave')
  async onTeamLeave(@ConnectedSocket() client: Socket) {
    const identity = this.identity(client);
    if (!identity) return;
    await this.run(client, 'TEAM_FAILED', () => this.team.leave(identity.characterId), 'team_update', () => this.team.info(identity.characterId));
  }

  @SubscribeMessage('team_disband')
  async onTeamDisband(@ConnectedSocket() client: Socket) {
    const identity = this.identity(client);
    if (!identity) return;
    await this.run(client, 'TEAM_FAILED', () => this.team.disband(identity.characterId), 'team_update', () => ({ in_team: false, team: null, members: [] }));
  }

  @SubscribeMessage('team_info')
  async onTeamInfo(@ConnectedSocket() client: Socket) {
    const identity = this.identity(client);
    if (!identity) return;
    await this.run(client, 'TEAM_FAILED', () => this.team.info(identity.characterId), 'team_update');
  }

  @SubscribeMessage('team_title')
  async onTeamTitle(@ConnectedSocket() client: Socket, @MessageBody() body: { show?: boolean }) {
    const identity = this.identity(client);
    if (!identity) return;
    await this.run(
      client,
      'TEAM_FAILED',
      async () => {
        const info = await this.team.info(identity.characterId);
        if (!info.in_team || !info.team) throw new Error('你不在队伍中');
        this.team.setTeamTitle(info.team.id, body?.show !== false);
        return this.team.info(identity.characterId);
      },
      'team_update',
    );
  }

  @SubscribeMessage('team_board')
  async onTeamBoard(@ConnectedSocket() client: Socket) {
    const identity = this.identity(client);
    if (!identity) return;
    await this.run(client, 'TEAM_FAILED', () => this.team.board(identity.characterId, ''), 'team_boarded', (value) => ({
      ship_id: value.ship.id,
      ship_name: value.ship.name,
      crew: 1,
      text: '你踩上队长的甲板，脚下晃了一下。',
    }));
  }

  @SubscribeMessage('team_disembark')
  async onTeamDisembark(@ConnectedSocket() client: Socket) {
    const identity = this.identity(client);
    if (!identity) return;
    await this.run(client, 'TEAM_FAILED', () => this.team.disembark(identity.characterId), 'team_boarded', (value) => ({
      ship_id: value.ship?.id ?? null,
      ship_name: value.ship?.name ?? null,
      text: '你回到自己的船上。',
    }));
  }

  @SubscribeMessage('pvp_attack')
  async onPvpAttack(@ConnectedSocket() client: Socket, @MessageBody() body: { name?: string }) {
    const identity = this.identity(client);
    if (!identity) return;
    await this.run(client, 'PVP_FAILED', () => this.conflict.duel(identity.characterId, body?.name ?? ''), 'pvp_result');
  }

  @SubscribeMessage('attack_base')
  async onAttackBase(@ConnectedSocket() client: Socket, @MessageBody() body: { island_id?: string }) {
    const identity = this.identity(client);
    if (!identity) return;
    await this.run(client, 'PVP_FAILED', () => this.conflict.attackBase(identity.characterId, body?.island_id), 'base_attack_result');
  }

  @SubscribeMessage('capture_start')
  async onCaptureStart(@ConnectedSocket() client: Socket, @MessageBody() body: { island_id?: string }) {
    const identity = this.identity(client);
    if (!identity) return;
    await this.run(client, 'PVP_FAILED', () => this.conflict.startCapture(identity.characterId, body?.island_id), 'capture_update');
  }

  @SubscribeMessage('capture_status')
  async onCaptureStatus(@ConnectedSocket() client: Socket, @MessageBody() body: { island_id?: string }) {
    const identity = this.identity(client);
    if (!identity) return;
    await this.run(client, 'PVP_FAILED', () => this.conflict.captureStatus(identity.characterId, body?.island_id), 'capture_update');
  }

  @SubscribeMessage('capture_cancel')
  async onCaptureCancel(@ConnectedSocket() client: Socket) {
    const identity = this.identity(client);
    if (!identity) return;
    await this.run(client, 'PVP_FAILED', () => this.conflict.cancelCapture(identity.characterId), 'capture_update');
  }

  @SubscribeMessage('trade_propose')
  async onTradePropose(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { name?: string; offer_ids?: string[]; want_ids?: string[] },
  ) {
    const identity = this.identity(client);
    if (!identity) return;
    await this.run(
      client,
      'TRADE_FAILED',
      () => this.trade.propose(identity.characterId, body?.name ?? '', body?.offer_ids ?? [], body?.want_ids ?? []),
      'trade_offered',
    );
  }

  @SubscribeMessage('trade_accept')
  async onTradeAccept(@ConnectedSocket() client: Socket, @MessageBody() body: { trade_id?: string }) {
    const identity = this.identity(client);
    if (!identity) return;
    await this.run(client, 'TRADE_FAILED', () => this.trade.accept(identity.characterId, body?.trade_id ?? ''), 'trade_result');
  }

  @SubscribeMessage('trade_decline')
  async onTradeDecline(@ConnectedSocket() client: Socket, @MessageBody() body: { trade_id?: string }) {
    const identity = this.identity(client);
    if (!identity) return;
    await this.run(client, 'TRADE_FAILED', () => this.trade.decline(identity.characterId, body?.trade_id ?? ''), 'trade_result');
  }

  @SubscribeMessage('trade_list')
  async onTradeList(@ConnectedSocket() client: Socket) {
    const identity = this.identity(client);
    if (!identity) return;
    await this.run(client, 'TRADE_FAILED', () => this.trade.list(identity.characterId), 'trade_list');
  }

  @SubscribeMessage('dead_drop')
  async onDeadDrop(@ConnectedSocket() client: Socket, @MessageBody() body: { item_ids?: string[] }) {
    const identity = this.identity(client);
    if (!identity) return;
    await this.run(client, 'TRADE_FAILED', () => this.trade.placeDrop(identity.characterId, body?.item_ids ?? []), 'dead_drop_placed');
  }

  @SubscribeMessage('dead_drop_take')
  async onDeadDropTake(@ConnectedSocket() client: Socket, @MessageBody() body: { drop_id?: string }) {
    const identity = this.identity(client);
    if (!identity) return;
    await this.run(client, 'TRADE_FAILED', () => this.trade.takeDrop(identity.characterId, body?.drop_id ?? ''), 'dead_drop_result');
  }

  @SubscribeMessage('skills')
  async onSkills(@ConnectedSocket() client: Socket) {
    const identity = this.identity(client);
    if (!identity) return;
    await this.run(client, 'SKILL_FAILED', () => this.skills.list(identity.characterId), 'skills_update');
  }

  @SubscribeMessage('heartbeat')
  async onHeartbeat(@ConnectedSocket() client: Socket) {
    const identity = this.identity(client);
    if (!identity) return;
    await this.run(client, 'FATIGUE_FAILED', () => this.fatigue.touch(identity.characterId), 'fatigue_update');
  }

  @SubscribeMessage('protection_set')
  async onProtectionSet(@ConnectedSocket() client: Socket, @MessageBody() body: { level?: number }) {
    const identity = this.identity(client);
    if (!identity) return;
    await this.run(client, 'PROTECTION_FAILED', () => this.protection.setProtection(identity.characterId, Number(body?.level ?? 0)), 'protection_update');
  }

  @SubscribeMessage('protection_status')
  async onProtectionStatus(@ConnectedSocket() client: Socket) {
    const identity = this.identity(client);
    if (!identity) return;
    await this.run(
      client,
      'PROTECTION_FAILED',
      async () => ({ ...(await this.protection.settle(identity.characterId)), ...(await this.protection.options()) }),
      'protection_update',
    );
  }

  @SubscribeMessage('monster_trade_offer')
  async onMonsterTradeOffer(@ConnectedSocket() client: Socket, @MessageBody() body: { monster_id?: string }) {
    const identity = this.identity(client);
    if (!identity) return;
    await this.run(client, 'MONSTER_FAILED', () => this.monsterAi.offerTrade(body?.monster_id ?? '', identity.characterId), 'monster_offer');
  }

  @SubscribeMessage('monster_trade_accept')
  async onMonsterTradeAccept(@ConnectedSocket() client: Socket, @MessageBody() body: { offer_id?: string }) {
    const identity = this.identity(client);
    if (!identity) return;
    await this.run(client, 'MONSTER_FAILED', () => this.monsterAi.acceptTrade(identity.characterId, body?.offer_id ?? ''), 'monster_trade_result');
  }

  @SubscribeMessage('monster_trade_list')
  async onMonsterTradeList(@ConnectedSocket() client: Socket) {
    const identity = this.identity(client);
    if (!identity) return;
    await this.run(client, 'MONSTER_FAILED', () => this.monsterAi.listOffers(identity.characterId), 'monster_offers');
  }

  // ---------------------------------------------------------------- event bus

  @OnEvent('combat.round_start')
  onRoundStart(payload: any): void {
    this.server.to(`channel:${payload.channel_id}`).emit('combat_round_start', payload);
  }

  @OnEvent('combat.round_result')
  onRoundResult(payload: any): void {
    this.server.to(`channel:${payload.channel_id}`).emit('combat_round_result', payload);
  }

  @OnEvent('combat.finished')
  onCombatFinished(payload: any): void {
    this.server.to(`channel:${payload.channel_id}`).emit('combat_finished', payload);
    if (payload.character_id) this.emitCharacterUpdate(payload.character_id);
  }

  @OnEvent('combat.revived')
  async onRevived(payload: any): Promise<void> {
    const character = await this.characters.get(payload.character_id);
    if (!character) return;
    const ship = await this.characters.getShip(character.ship_id);
    const state = await this.world.getState();
    const socket = this.sockets.get(payload.character_id);
    if (socket) {
      socket.join(`channel:${FIXED_IDS.SEA_CHANNEL}`);
      socket.leave(`channel:${FIXED_IDS.PRESET_ISLAND_CHANNEL}`);
      socket.emit('narration', {
        channel_id: FIXED_IDS.SEA_CHANNEL,
        text: payload.narration,
        kind: 'revive',
      });
      socket.emit('position', this.positionPayload(character, ship, state));
      socket.emit('channel_changed', { channel_id: FIXED_IDS.SEA_CHANNEL, island_id: null });
    }
    this.emitCharacterUpdate(character.id);
  }

  @OnEvent('character.update')
  async onCharacterUpdate(payload: { character_id: string }): Promise<void> {
    this.emitCharacterUpdate(payload.character_id);
  }

  @OnEvent('world.tick')
  onWorldTick(payload: any): void {
    this.server.emit('world_tick', {
      world_day: payload.world_day,
      world_hour: payload.world_hour,
      day_night: payload.day_night,
      current: payload.current,
    });
  }

  @OnEvent('world.day')
  async onWorldDay(payload: any): Promise<void> {
    this.server.to(`channel:${FIXED_IDS.SEA_CHANNEL}`).emit('narration', {
      channel_id: FIXED_IDS.SEA_CHANNEL,
      text: `世界进入第 ${payload.world_day} 日，洋流转向${Math.round(payload.current)}°。`,
      kind: 'world',
    });
  }

  // ---------------------------------------------------------------- 文字指令

  /** 返回 true 表示已当作指令处理，不再进入聊天广播 */
  private async handleTextCommand(client: Socket, character: any, text: string): Promise<boolean> {
    const intent = parseIntent(text);
    const state = this.commandStates.get(character.id);
    // 问句（“附近有岛吗？”）优先当作正常聊天，让 AI 回答
    if (!state && /[?？]\s*$/.test(text)) return false;
    const islandChannel = character.island_id ? await this.islands.channelOf(character.island_id) : null;
    const channelId = islandChannel?.id ?? FIXED_IDS.SEA_CHANNEL;
    const say = (message: string) => {
      client.emit('narration', { channel_id: channelId, text: message, kind: 'command' });
      client.emit('command_reply', { text: message });
    };

    if (intent === 'cancel') {
      this.commandStates.delete(character.id);
      this.islandCreate.cancel(character.id);
      say('好，先不做了。发「菜单」看看还能做什么。');
      return true;
    }

    // —— 启航追问：方向 → 航程
    if (state?.mode === 'sail_direction') {
      const angle = parseDirection(text);
      if (angle === null) {
        say('这个方向我没看懂。发 0–359 的数字，或者「东北」「西南」这样的词。');
        return true;
      }
      state.mode = 'sail_distance';
      state.angle = angle;
      say(`朝 ${Math.round(angle)}°。航程多少海里？（直接发数字，1–30）`);
      return true;
    }
    if (state?.mode === 'sail_distance') {
      const distance = parseDistance(text);
      if (distance === null) {
        say('航程需要一个数字，比如 5。');
        return true;
      }
      this.commandStates.delete(character.id);
      const result = await this.movement.move(character.id, state.angle ?? 0, distance);
      if (result.refused) {
        say(result.refused);
        return true;
      }
      await this.afterTravel(client, result);
      say(`航行了 ${round1(result.distance)} 海里，天又过了一截。`);
      return true;
    }

    // —— 造岛：一段话 → 缺口追问 → 确认
    if (state?.mode === 'island_text') {
      try {
        const started = await this.islandCreate.startFromText(character, text);
        say(started.say);
        this.commandStates.set(character.id, { mode: started.complete ? 'confirm_island' : 'island_fill' });
      } catch (err) {
        say(`这段话没整理出来：${(err as Error).message}`);
      }
      return true;
    }
    if (state?.mode === 'island_fill') {
      try {
        const answered = this.islandCreate.answerMissing(character.id, text);
        say(answered.say);
        if (answered.complete) this.commandStates.set(character.id, { mode: 'confirm_island' });
      } catch (err) {
        say((err as Error).message);
      }
      return true;
    }

    if (intent === 'menu' || intent === 'unknown') {
      if (intent === 'unknown') return false;
      say(MENU_TEXT);
      return true;
    }

    switch (intent) {
      case 'sail': {
        if (character.island_id) return say('你还在岛上，先发「离岛」。'), true;
        this.commandStates.set(character.id, { mode: 'sail_direction' });
        say('往哪个方向？发 0–359 的数字，或「东北」「西南」这样的词。');
        return true;
      }
      case 'drift': {
        try {
          const result = await this.movement.drift(character.id);
          if (result.refused) say(result.refused);
          else {
            await this.afterTravel(client, result);
            say('你松开舵，让洋流带着船走。');
          }
        } catch (err) {
          say((err as Error).message);
        }
        return true;
      }
      case 'nearby': {
        const nearest = await this.islands.nearest(character.x, character.y);
        const state2 = await this.world.getState();
        if (!nearest) {
          say(`四周只有水。当前海域半径 ${round1(state2.sea_radius_nm)} 海里。`);
          return true;
        }
        const direction = bearingText(bearingDeg(character.x, character.y, nearest.island.x, nearest.island.y));
        const range = nearest.island.radius;
        say(
          `最近的岛在${direction}方向，约 ${round1(nearest.distance)} 海里（影响半径 ${range} 海里）。` +
            (nearest.distance <= range ? '已经够近了，发「上岛」就能靠岸。' : '还得再靠近一些。'),
        );
        return true;
      }
      case 'enter': {
        if (character.island_id) return say('你已经在岛上了。'), true;
        const nearest = await this.islands.nearest(character.x, character.y);
        if (!nearest || nearest.distance > nearest.island.radius) {
          return say('附近没有够近的岛。先发「启航」或「漂流」靠近。'), true;
        }
        client.emit('command_action', { emit: 'enter_island', payload: { island_id: nearest.island.id } });
        say(`你朝${nearest.island.name}的岸边靠过去。`);
        return true;
      }
      case 'leave': {
        if (!character.island_id) return say('你本来就在海上。'), true;
        client.emit('command_action', { emit: 'leave_island', payload: {} });
        say('你转身走向船，脚下从沙地变回甲板。');
        return true;
      }
      case 'attack':
      case 'defend':
      case 'flee': {
        const runtime = this.combat.activeFor(character.id);
        if (!runtime) return say('现在没有战斗。上岛遇到活物才会打起来。'), true;
        const target = runtime.participants.find((p: any) => p.side === 'monster' && p.hp > 0);
        const result = await this.combat.submitAction(runtime.id, character.id, {
          action: intent === 'attack' ? 'attack' : intent === 'defend' ? 'defend' : 'flee',
          target_id: target?.id,
        } as any);
        say(result.ok ? '动作已提交，等这一回合结算。' : result.message ?? '这个动作现在做不了。');
        return true;
      }
      case 'collect': {
        if (!character.island_id) return say('你不在岛上，没什么可搜的。'), true;
        try {
          const result = await this.collectService.collect(character, character.island_id, text);
          say(`${result.narration}（成功率 ${Math.round(result.chance * 100)}%，掷出 ${(result.roll * 100).toFixed(0)}）`);
          this.emitCharacterUpdate(character.id);
        } catch (err) {
          say((err as Error).message);
        }
        return true;
      }
      case 'skills': {
        try {
          const list = await this.skills.list(character.id);
          if (!list.skills.length) say(`你还没有领悟技能。资质：${list.aptitude}，到 1/3/5/7 级会自然领悟。`);
          else say(`已领悟：\n${list.skills.map((s: any) => `· ${s.name}（${s.level_unlocked} 级）：${s.description}`).join('\n')}`);
        } catch (err) {
          say((err as Error).message);
        }
        return true;
      }
      case 'team': {
        const name = text.replace(/^(组队|建队|创建队伍)\s*/, '').trim();
        if (!name) return say('给队伍起个名字，发送：建队 碎浪'), true;
        try {
          await this.team.create(character.id, name);
          say(`队伍「${name}」建好了。让队友发「队伍」，我再教他怎么加入。`);
        } catch (err) {
          say((err as Error).message);
        }
        return true;
      }
      case 'team_info': {
        try {
          const info = await this.team.info(character.id);
          if (!info.in_team) say('你还没有队伍。发送「建队 队名」创建一个。');
          else say(`队伍「${info.team?.name}」，共 ${info.members.length} 人：${info.members.map((m: any) => `${m.name}（Lv.${m.level}）`).join('、')}`);
        } catch (err) {
          say((err as Error).message);
        }
        return true;
      }
      case 'trade': {
        say('面对面才能交易：先和对方站到同一座岛或 1 海里内，再说「和他换东西」，我会问你要换什么。');
        return true;
      }
      case 'island_create': {
        this.commandStates.set(character.id, { mode: 'island_text' });
        say('用一段话把岛说清楚：叫什么、什么样子、有什么规矩、产什么、有什么怪物、几只、最高几级。想到多少说多少，缺的我再问。');
        return true;
      }
      case 'confirm': {
        try {
          const result = await this.islandCreate.confirmText(character);
          this.commandStates.delete(character.id);
          client.emit('island_created', { island_id: result.island.id, name: result.island.name, summary: result.summary });
          say(`岛造好了：${result.island.name}。位置不会告诉你，得自己找。`);
        } catch (err) {
          say((err as Error).message);
        }
        return true;
      }
      case 'status': {
        const ship = await this.characters.getShip(character.ship_id);
        const lines = [
          `${character.name}｜Lv.${character.level}｜${character.aptitude}`,
          `生命 ${character.hp}/${character.max_hp}｜疲劳 ${character.fatigue}｜保护期 ${character.protection_active ? `生效（到 ${character.protection_level} 级）` : '已结束'}`,
          ship ? `船：${ship.name}｜燃料 ${round1(ship.fuel)}｜耐久 ${ship.hp}/${ship.max_hp}` : '没有船',
          `位置：${character.island_id ? '岛上' : `${round1(character.x)}, ${round1(character.y)}`}`,
        ];
        say(lines.join('\n'));
        return true;
      }
      default:
        return false;
    }
  }

  // ---------------------------------------------------------------- helpers

  private identity(client: Socket): SocketIdentity | null {
    const identity = client.data as SocketIdentity;
    if (!identity?.characterId) {
      this.emitError(client, 'AUTH_REQUIRED', '请先登录');
      return null;
    }
    return identity;
  }

  private emitError(client: Socket, code: string, message: string): void {
    client.emit('error', { code, message });
  }

  private async emitCharacterUpdate(characterId: string): Promise<void> {
    const character = await this.characters.get(characterId);
    if (!character) return;
    const socket = this.sockets.get(characterId);
    if (socket) socket.emit('character_update', { character });
  }

  private positionPayload(character: any, ship: any, state: any) {
    return {
      x: Math.round(character.x * 10) / 10,
      y: Math.round(character.y * 10) / 10,
      world_day: state.world_day,
      world_hour: Math.floor(state.world_minutes / 60),
      world_minutes: state.world_minutes,
      day_night: this.world.isNight(state.world_minutes) ? 'night' : 'day',
      fuel: ship?.fuel ?? 0,
      hp: character.hp,
      max_hp: character.max_hp,
      status: character.status,
      island_id: character.island_id,
    };
  }
}
