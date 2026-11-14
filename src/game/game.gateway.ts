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
import { FIXED_IDS } from '../database/seed.service';
import { GAME } from '../game/constants';
import { envInt } from '../common/env';
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
