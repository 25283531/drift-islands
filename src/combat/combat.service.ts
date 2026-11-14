import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { Character, Ship } from '../database/entities/character.entities';
import { Monster } from '../database/entities/island.entities';
import { Item } from '../database/entities/item.entities';
import { CombatSession } from '../database/entities/combat.entity';
import { CharactersService } from '../characters/characters.service';import { NarratorService } from '../ai/narrator.service';
import { CrystalsService } from '../crystals/crystals.service';
import { WorldService } from '../world/world.service';
import { FLEE, GAME } from '../game/constants';
import { envInt } from '../common/env';
import {
  attackDamage,
  monsterFleeChance,
  playerAttackPower,
  playerDefense,
  playerFleeChance,
} from './combat.rules';

export type CombatActionType = 'attack' | 'defend' | 'use_item' | 'flee' | 'skill';

export interface CombatAction {
  action: CombatActionType;
  target_id?: string;
  item_id?: string;
}

export interface Combatant {
  id: string;
  side: 'player' | 'monster';
  name: string;
  hp: number;
  maxHp: number;
  speed: number;
  attack: number;
  defense: number;
  level: number;
  refId: string;
  alive: boolean;
}

interface Runtime {
  id: string;
  channelId: string;
  islandId: string;
  characterId: string;
  shipId: string | null;
  round: number;
  state: 'active' | 'finished';
  participants: Combatant[];
  actions: Map<string, CombatAction>;
  log: { round: number; text: string; events: string[] }[];
  timer: NodeJS.Timeout | null;
  resolving: boolean;
  roundDeadline: number;
  /** 玩家最近一次锁定的目标，之后不操作也继续打它 */
  preferredTarget?: string;
}

@Injectable()
export class CombatService implements OnModuleDestroy {
  private readonly logger = new Logger(CombatService.name);
  private readonly sessions = new Map<string, Runtime>();
  private readonly byCharacter = new Map<string, string>();

  constructor(
    @InjectRepository(CombatSession) private readonly repo: Repository<CombatSession>,
    @InjectRepository(Item) private readonly items: Repository<Item>,
    @InjectRepository(Monster) private readonly monsters: Repository<Monster>,
    private readonly characters: CharactersService,
    private readonly narrator: NarratorService,
    private readonly world: WorldService,
    private readonly crystals: CrystalsService,
    private readonly events: EventEmitter2,
  ) {}

  onModuleDestroy(): void {
    for (const runtime of this.sessions.values()) {
      if (runtime.timer) clearTimeout(runtime.timer);
    }
    this.sessions.clear();
    this.byCharacter.clear();
  }

  get roundMs(): number {
    return envInt('COMBAT_ROUND_MS', GAME.COMBAT_ROUND_MS);
  }

  activeFor(characterId: string): Runtime | null {
    const id = this.byCharacter.get(characterId);
    if (!id) return null;
    const runtime = this.sessions.get(id);
    return runtime && runtime.state === 'active' ? runtime : null;
  }

  get(combatId: string): Runtime | null {
    return this.sessions.get(combatId) ?? null;
  }

  private monstersInUse(): Set<string> {
    const inUse = new Set<string>();
    for (const runtime of this.sessions.values()) {
      if (runtime.state !== 'active') continue;
      for (const participant of runtime.participants) {
        if (participant.side === 'monster' && participant.alive) inUse.add(participant.id);
      }
    }
    return inUse;
  }

  /**
   * 清理遗留战斗（M5 修复）：
   * - 角色已不在战斗状态（掉线/离开/进程重起）的会话直接丢弃；
   * - 没有任何活跃会话引用的 combat 怪物释放回 idle，避免整座岛永久卡死。
   */
  async recover(islandId?: string): Promise<{ sessions: number; released: number }> {
    let sessions = 0;
    for (const [id, runtime] of [...this.sessions.entries()]) {
      if (islandId && runtime.islandId !== islandId) continue;
      const character = await this.characters.get(runtime.characterId).catch(() => null);
      if (character && character.status === 'in_combat' && runtime.state === 'active') continue;
      if (runtime.timer) clearTimeout(runtime.timer);
      runtime.state = 'finished';
      this.sessions.delete(id);
      this.byCharacter.delete(runtime.characterId);
      sessions += 1;
    }

    const bound = this.monstersInUse();
    const rows = await this.monsters.find({
      where: islandId ? { island_id: islandId, state: 'combat' } : { state: 'combat' },
    });
    let released = 0;
    for (const monster of rows) {
      if (bound.has(monster.id)) continue;
      // 上一场异常中断时可能停在 0 血，恢复成可再战状态
      if (monster.hp <= 0) monster.hp = monster.max_hp;
      monster.state = 'idle';
      await this.monsters.save(monster);
      released += 1;
    }
    return { sessions, released };
  }

  /** 进入岛屿遇到活怪即开战（§4.2 战斗基础版） */
  async startCombat(params: {
    character: Character;
    ship: Ship;
    islandId: string;
    channelId: string;
    monsters: Monster[];
  }): Promise<Runtime | null> {
    const { character, ship, islandId, channelId, monsters } = params;
    const existing = this.activeFor(character.id);
    if (existing) return existing;

    // 先释放上一场遗留：卡在 combat 的怪物回 idle，失效会话清掉
    await this.recover(islandId);

    const inUse = this.monstersInUse();
    const wanted = new Set(monsters.map((monster) => monster.id));
    const fresh = (
      await this.monsters.find({ where: { island_id: islandId, state: Not('dead') } })
    ).filter((monster) => wanted.has(monster.id) && !inUse.has(monster.id) && monster.hp > 0);
    if (fresh.length === 0) return null;

    const participants: Combatant[] = [
      {
        id: character.id,
        side: 'player',
        name: character.name,
        hp: character.hp,
        maxHp: character.max_hp,
        speed: character.speed,
        attack: playerAttackPower(character.level, ship.weapon_power),
        defense: playerDefense(ship.defense_lv),
        level: character.level,
        refId: character.id,
        alive: character.hp > 0,
      },
      ...fresh.map((m) => ({
        id: m.id,
        side: 'monster' as const,
        name: m.custom_name ?? this.monsterName(m),
        hp: m.hp,
        maxHp: m.max_hp,
        speed: m.speed,
        attack: m.attack,
        defense: 1 + m.level,
        level: m.level,
        refId: m.id,
        alive: m.hp > 0,
      })),
    ];

    const runtime: Runtime = {
      id: randomUUID(),
      channelId,
      islandId,
      characterId: character.id,
      shipId: ship.id,
      round: 0,
      state: 'active',
      participants,
      actions: new Map(),
      log: [],
      timer: null,
      resolving: false,
      roundDeadline: 0,
    };
    this.sessions.set(runtime.id, runtime);
    this.byCharacter.set(character.id, runtime.id);

    character.status = 'in_combat';
    await this.characters.save(character);
    for (const monster of fresh) {
      monster.state = 'combat';
      await this.monsters.save(monster);
    }

    await this.persist(runtime);
    this.startRound(runtime);
    return runtime;
  }

  private monsterName(monster: Monster): string {
    return monster.custom_name ?? (monster as any).display_name ?? `怪物 Lv.${monster.level}`;
  }

  private playerView(runtime: Runtime) {
    const player = runtime.participants.find((p) => p.side === 'player');
    if (!player) return null;
    return {
      name: player.name,
      hp: player.hp,
      max_hp: player.maxHp,
      attack: player.attack,
      defense: player.defense,
      level: player.level,
    };
  }

  private monsterView(runtime: Runtime) {
    return runtime.participants
      .filter((p) => p.side === 'monster')
      .map((monster, index) => ({
        index: index + 1,
        id: monster.id,
        name: monster.name,
        hp: monster.hp,
        max_hp: monster.maxHp,
        level: monster.level,
        alive: monster.alive,
      }));
  }

  /** 聊天里每回合都能看到的硬指标，不依赖模型叙述 */
  private statusText(runtime: Runtime): string {
    const player = runtime.participants.find((p) => p.side === 'player');
    const queue = this.monsterView(runtime)
      .map((m) => `${m.index}.${m.name} ${m.hp}/${m.max_hp}${m.alive ? '' : '（倒）'}`)
      .join(' ');
    return `你 ${player?.hp ?? 0}/${player?.maxHp ?? 0}｜攻 ${player?.attack ?? 0} 防 ${player?.defense ?? 0}｜${queue}`;
  }

  private startRound(runtime: Runtime): void {
    if (runtime.state !== 'active') return;
    runtime.round += 1;
    runtime.actions.clear();
    runtime.roundDeadline = Date.now() + this.roundMs;

    this.events.emit('combat.round_start', {
      combat_id: runtime.id,
      channel_id: runtime.channelId,
      round: runtime.round,
      deadline_ms: this.roundMs,
      auto_attack: true,
      you: this.playerView(runtime),
      queue: this.monsterView(runtime),
      status_text: this.statusText(runtime),
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

    runtime.timer = setTimeout(() => {
      void this.resolveRound(runtime.id);
    }, this.roundMs);
    runtime.timer.unref?.();
  }

  async submitAction(
    combatId: string,
    characterId: string,
    action: CombatAction,
  ): Promise<{ ok: boolean; message?: string }> {
    const runtime = this.sessions.get(combatId);
    if (!runtime || runtime.state !== 'active') return { ok: false, message: '战斗已经结束' };
    if (runtime.characterId !== characterId) return { ok: false, message: '这场战斗不属于你' };
    if (runtime.resolving) return { ok: false, message: '回合正在结算' };
    if (!['attack', 'defend', 'use_item', 'flee', 'skill'].includes(action?.action)) {
      return { ok: false, message: '未知的战斗动作' };
    }
    if (runtime.actions.has(characterId)) return { ok: false, message: '本回合已经提交过行动' };

    if (action.action === 'attack') {
      const monsters = runtime.participants.filter((p) => p.side === 'monster' && p.alive);
      const chosen = action.target_id ? monsters.find((m) => m.id === action.target_id) : undefined;
      const preferred = runtime.preferredTarget
        ? monsters.find((m) => m.id === runtime.preferredTarget)
        : undefined;
      const target = chosen ?? preferred ?? monsters[0];
      if (target) {
        action.target_id = target.id;
        if (chosen) runtime.preferredTarget = chosen.id;
      }
    }
    runtime.actions.set(characterId, action);
    if (this.allPlayersActed(runtime)) {
      if (runtime.timer) {
        clearTimeout(runtime.timer);
        runtime.timer = null;
      }
      // 所有玩家都提交后立即结算
      setTimeout(() => void this.resolveRound(runtime.id), 0);
    }
    return { ok: true };
  }

  private allPlayersActed(runtime: Runtime): boolean {
    return runtime.participants
      .filter((p) => p.side === 'player' && p.alive)
      .every((p) => runtime.actions.has(p.id));
  }

  /** 测试 / 调试：立即结算当前回合 */
  async resolveNow(combatId: string): Promise<void> {
    await this.resolveRound(combatId);
  }

  private async resolveRound(combatId: string): Promise<void> {
    const runtime = this.sessions.get(combatId);
    if (!runtime || runtime.state !== 'active' || runtime.resolving) return;
    runtime.resolving = true;
    if (runtime.timer) {
      clearTimeout(runtime.timer);
      runtime.timer = null;
    }

    try {
      const events: string[] = [];
      const order = [...runtime.participants]
        .filter((p) => p.alive)
        .sort((a, b) => (b.speed === a.speed ? Math.random() - 0.5 : b.speed - a.speed));

      for (const actor of order) {
        if (runtime.state !== 'active') break;
        if (!actor.alive) continue;

        if (actor.side === 'player') {
          const submitted = runtime.actions.get(actor.id);
          const action = submitted ?? {
            action: 'attack' as CombatActionType,
            target_id: runtime.preferredTarget,
          };
          const timeout = !submitted;
          this.executePlayerAction(runtime, actor, action, events, timeout);
        } else {
          this.executeMonsterAction(runtime, actor, events);
        }

        this.checkEnd(runtime);
      }

      if (runtime.state === 'active') {
        const narration = await this.narrator.render(
          'combat_round',
          { round: runtime.round, events },
          { userId: (await this.characters.get(runtime.characterId))?.user_id, tier: 'small' },
        );
        runtime.log.push({ round: runtime.round, text: narration.text, events });
        const statusText = this.statusText(runtime);
        this.events.emit('combat.round_result', {
          combat_id: runtime.id,
          channel_id: runtime.channelId,
          round: runtime.round,
          you: this.playerView(runtime),
          queue: this.monsterView(runtime),
          status_text: statusText,
          results: runtime.participants.map((p) => ({
            id: p.id,
            side: p.side,
            name: p.name,
            hp: p.hp,
            max_hp: p.maxHp,
            alive: p.alive,
          })),
          events,
          narration: `${narration.text}\n${statusText}`,
        });
        await this.persist(runtime);
        runtime.resolving = false;
        if (runtime.state === 'active') {
          // 短暂停顿后开始下一回合（15 秒限时由下一回合重新计时）
          setTimeout(() => this.startRound(runtime), 800).unref?.();
        }
      } else {
        await this.persist(runtime);
        runtime.resolving = false;
      }
    } catch (err) {
      runtime.resolving = false;
      this.logger.error(`回合结算失败：${(err as Error).message}`);
      if (runtime.state === 'active') {
        setTimeout(() => this.startRound(runtime), 1000).unref?.();
      }
    }
  }

  private executePlayerAction(
    runtime: Runtime,
    actor: Combatant,
    action: CombatAction,
    events: string[],
    timeout: boolean,
  ): void {
    const monsters = runtime.participants.filter((p) => p.side === 'monster' && p.alive);

    if (timeout) {
      events.push(`${actor.name} 没来得及下令，自动开火`);
    }

    switch (action.action) {
      case 'defend':
        events.push(`${actor.name} 收帆举盾，摆出防守姿态`);
        return;
      case 'flee': {
        if (monsters.length === 0) return;
        const fastest = Math.max(...monsters.map((m) => m.speed));
        const chance = playerFleeChance(actor.speed, fastest);
        if (Math.random() < chance) {
          events.push(`${actor.name} 抓住一个空档，甩开追击退到浅滩`);
          void this.finish(runtime, 'fled');
        } else {
          events.push(`${actor.name} 想跑，被怪物缠住了`);
        }
        return;
      }
      case 'use_item': {
        const target = monsters.find((m) => m.id === action.target_id) ?? monsters[0];
        events.push(`${actor.name} 去摸药品，背包里却没有能用的东西`);
        if (!target) return;
        return;
      }
      case 'skill':
        events.push(`${actor.name} 想动用技能，但这个等级还没有领悟任何技能`);
        return;
      case 'attack':
      default: {
        const target = monsters.find((m) => m.id === action.target_id) ?? monsters[0];
        if (!target) return;
        const damage = attackDamage(actor.attack, target.defense);
        target.hp = Math.max(0, target.hp - damage);
        if (target.hp <= 0) {
          target.alive = false;
          events.push(`${actor.name} 击中 ${target.name}，造成 ${damage} 点伤害，${target.name} 倒下了`);
        } else {
          events.push(`${actor.name} 击中 ${target.name}，造成 ${damage} 点伤害`);
        }
        return;
      }
    }
  }

  private executeMonsterAction(runtime: Runtime, actor: Combatant, events: string[]): void {
    const player = runtime.participants.find((p) => p.side === 'player' && p.alive);
    if (!player) return;

    // 怪物血量 ≤30% 时每回合判定逃跑（1–3 级 50%，4–6 级 20%，7 级不逃跑）
    if (actor.hp <= actor.maxHp * 0.3) {
      const chance = monsterFleeChance(actor.level);
      if (chance > 0 && Math.random() < chance) {
        actor.alive = false;
        events.push(`${actor.name} 见势不妙，转身钻进岛内的废墟`);
        return;
      }
    }

    const defending = runtime.actions.get(player.id)?.action === 'defend';
    const damage = attackDamage(actor.attack, player.defense, defending);
    player.hp = Math.max(0, player.hp - damage);
    if (player.hp <= 0) {
      player.alive = false;
      events.push(`${actor.name} 扑上来，造成 ${damage} 点伤害，${player.name} 倒下了`);
    } else {
      events.push(`${actor.name} 攻击 ${player.name}，造成 ${damage} 点伤害`);
    }
  }

  private checkEnd(runtime: Runtime): void {
    if (runtime.state !== 'active') return;
    const monstersLeft = runtime.participants.some((p) => p.side === 'monster' && p.alive);
    const player = runtime.participants.find((p) => p.side === 'player');
    if (!player?.alive) {
      void this.finish(runtime, 'defeat');
      return;
    }
    if (!monstersLeft) {
      void this.finish(runtime, 'victory');
    }
  }

  private async finish(runtime: Runtime, outcome: 'victory' | 'defeat' | 'fled'): Promise<void> {
    if (runtime.state === 'finished') return;
    runtime.state = 'finished';
    if (runtime.timer) clearTimeout(runtime.timer);
    this.byCharacter.delete(runtime.characterId);
    this.sessions.delete(runtime.id);

    const character = await this.characters.get(runtime.characterId);
    if (!character) return;
    const player = runtime.participants.find((p) => p.side === 'player');
    const monsters = runtime.participants.filter((p) => p.side === 'monster');

    const deadRows: Monster[] = [];
    for (const monster of monsters) {
      const row = await this.monsters.findOne({ where: { id: monster.refId } });
      if (!row) continue;
      row.hp = monster.hp;
      row.state = monster.alive ? 'idle' : 'dead';
      await this.monsters.save(row);
      if (!monster.alive) deadRows.push(row);
    }

    if (outcome === 'defeat') {
      character.hp = 0;
      character.status = 'dead';
      await this.characters.save(character);
      const narration = await this.narrator.render(
        'death',
        { place: `岛上（${Math.round(character.x)}, ${Math.round(character.y)}）` },
        { userId: character.user_id },
      );
      this.events.emit('combat.finished', {
        combat_id: runtime.id,
        channel_id: runtime.channelId,
        outcome,
        narration: narration.text,
        character_id: character.id,
      });
      this.events.emit('character.update', { character_id: character.id });
      setTimeout(() => void this.revive(character.id), 3000).unref?.();
      return;
    }

    character.hp = player?.hp ?? character.hp;
    character.status = 'online';
    await this.characters.save(character);

    // M2：击杀掉落晶核（等级 = 怪物等级，§4.2）
    const dropped: { level: number; energy: number }[] = [];
    if (outcome === 'victory') {
      for (const row of deadRows) {
        const crystal = await this.crystals.dropForMonster(row, character.id);
        dropped.push({ level: crystal.level, energy: crystal.energy_total });
      }
    }

    const narrationKind = outcome === 'victory' ? 'combat_victory' : 'combat_defeat';
    const narration = await this.narrator.render(
      narrationKind,
      {
        detail:
          outcome === 'victory'
            ? '尸体很快沉进浅水，你听见船坞深处还有别的动静。'
            : '你退到滩涂上，身后的怪物没有追出来。',
      },
      { userId: character.user_id },
    );
    this.events.emit('combat.finished', {
      combat_id: runtime.id,
      channel_id: runtime.channelId,
      outcome,
      narration: narration.text,
      character_id: character.id,
      crystals: dropped,
    });
    this.events.emit('character.update', { character_id: character.id });

    if (outcome === 'victory') {
      const world = await this.world.getState();
      await this.characters.recordExperience(
        character.id,
        world.world_day,
        world.world_minutes,
        'combat',
        `在岛屿上击倒了 ${monsters.length} 只怪物`,
      );
    }
  }

  /** 死亡复活：初始船、海域内随机坐标（§4.2）；M1 不实现物品掉落（M2 补） */
  async revive(characterId: string): Promise<void> {
    const character = await this.characters.get(characterId);
    if (!character || character.status !== 'dead') return;
    const state = await this.world.getState();
    const angle = Math.random() * Math.PI * 2;
    const radius = 5 + Math.random() * (state.sea_radius_nm * 0.5 - 5);
    character.x = Math.cos(angle) * radius;
    character.y = Math.sin(angle) * radius;
    character.island_id = null;
    character.hp = Math.max(1, Math.round(character.max_hp * 0.3));
    character.status = 'online';
    await this.characters.save(character);

    const ship = await this.characters.getShip(character.ship_id);
    if (ship) {
      ship.x = character.x;
      ship.y = character.y;
      await this.characters.saveShip(ship);
    }

    const world = await this.world.getState();
    const narration = await this.narrator.render(
      'revive',
      { world_day: world.world_day, x: character.x, y: character.y },
      { userId: character.user_id },
    );
    this.events.emit('combat.revived', {
      character_id: character.id,
      narration: narration.text,
      x: character.x,
      y: character.y,
    });
    this.events.emit('character.update', { character_id: character.id });
  }

  private async persist(runtime: Runtime): Promise<void> {
    let row = await this.repo.findOne({ where: { id: runtime.id } });
    if (!row) {
      row = this.repo.create({ id: runtime.id, created_at: new Date() });
    }
    row.channel_id = runtime.channelId;
    row.island_id = runtime.islandId;
    row.state = runtime.state;
    row.round = runtime.round;
    row.round_deadline = runtime.roundDeadline ? new Date(runtime.roundDeadline) : null;
    row.participants = runtime.participants;
    row.actions = Object.fromEntries(runtime.actions);
    row.log = runtime.log;
    await this.repo.save(row);
  }
}
