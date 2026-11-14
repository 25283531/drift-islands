import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { Character, Ship } from '../database/entities/character.entities';
import { Island } from '../database/entities/island.entities';
import { DeadDrop, Item } from '../database/entities/item.entities';
import { CharactersService } from '../characters/characters.service';
import { WorldService } from '../world/world.service';
import { distanceNm, round1 } from '../game/geo';
import { CAPTURE_MINUTES, captureComplete, captureProgress } from '../game/m3';

export interface DuelRound {
  round: number;
  attacker_damage: number;
  defender_damage: number;
  attacker_hp: number;
  defender_hp: number;
  text: string;
}

/** PvP、基地攻防与夺岛（§4.2） */
@Injectable()
export class ConflictService {
  constructor(
    @InjectRepository(Character) private readonly characters: Repository<Character>,
    @InjectRepository(Ship) private readonly ships: Repository<Ship>,
    @InjectRepository(Island) private readonly islands: Repository<Island>,
    @InjectRepository(Item) private readonly items: Repository<Item>,
    @InjectRepository(DeadDrop) private readonly drops: Repository<DeadDrop>,
    private readonly charactersService: CharactersService,
    private readonly world: WorldService,
  ) {}

  /** 面对面挑战；双方各自结算，先倒下的掉落全部随身物 */
  async duel(attackerId: string, targetName: string) {
    const attacker = await this.must(attackerId);
    const target = await this.characters.findOne({ where: { name: (targetName ?? '').trim() } });
    if (!target) throw new Error('找不到这个角色');
    if (target.id === attacker.id) throw new Error('不能攻击自己');
    if (target.status === 'dead') throw new Error('对方已经倒下');
    if (!this.samePlace(attacker, target)) throw new Error('必须面对面：同岛或 1 海里内');
    if (attacker.status === 'in_combat') throw new Error('你正在战斗中');

    const attackerShip = await this.charactersService.getShip(attacker.ship_id);
    const targetShip = await this.charactersService.getShip(target.ship_id);
    const aPower = this.power(attacker, attackerShip);
    const dPower = this.power(target, targetShip);
    let aHp = attacker.hp;
    let dHp = target.hp;
    const rounds: DuelRound[] = [];

    for (let round = 1; round <= 6 && aHp > 0 && dHp > 0; round += 1) {
      const aDamage = Math.max(1, Math.round(aPower * (0.7 + Math.random() * 0.6)));
      const dDamage = Math.max(1, Math.round(dPower * (0.7 + Math.random() * 0.6)));
      dHp = Math.max(0, dHp - aDamage);
      aHp = Math.max(0, aHp - dDamage);
      rounds.push({
        round,
        attacker_damage: aDamage,
        defender_damage: dDamage,
        attacker_hp: aHp,
        defender_hp: dHp,
        text: `第 ${round} 回合：你造成 ${aDamage} 伤害，对方还手 ${dDamage}。`,
      });
      if (aHp <= 0 || dHp <= 0) break;
    }

    attacker.hp = Math.max(1, aHp);
    target.hp = Math.max(0, dHp);
    const attackerWon = dHp <= 0 && aHp > 0;
    if (target.hp <= 0) {
      target.status = 'dead';
      await this.dropAll(target);
    }
    await this.characters.save(attacker);
    await this.characters.save(target);

    return {
      winner: attackerWon ? attacker.id : target.id,
      attacker_won: attackerWon,
      rounds,
      power: { attacker: aPower, defender: dPower },
      hp: { attacker: attacker.hp, defender: target.hp },
      looted: target.hp <= 0,
      narration: attackerWon
        ? `${target.name} 的膝盖先撞上甲板，声音很闷。你收起武器，海面又安静下来。`
        : `你被逼到船舷，视野一阵发白。${target.name} 没有追上来。`,
    };
  }

  /** 攻击岛主基地，逐级摧毁防御 */
  async attackBase(characterId: string, islandId?: string) {
    const character = await this.must(characterId);
    const island = await this.islandFor(character, islandId);
    if (!island.owner_character_id) throw new Error('这座岛还没有主人，直接驻扎即可');
    if (island.owner_character_id === character.id) throw new Error('这是你自己的岛');
    if (character.status === 'in_combat') throw new Error('你正在战斗中');

    const buildings = this.buildingsOf(island);
    const defenseLv = Number(buildings.defense_lv ?? 0);
    if (defenseLv <= 0) throw new Error('防御已经被摧毁，可以直接占领');

    const ship = await this.charactersService.getShip(character.ship_id);
    const attack = this.power(character, ship);
    const defense = 10 + defenseLv * 12;
    const damage = Math.max(1, Math.round(attack * (0.8 + Math.random() * 0.4)));
    const destroyed = damage >= defense;

    if (destroyed) {
      buildings.defense_lv = Math.max(0, defenseLv - 1);
      island.defenses = [];
      island.buildings = buildings;
      await this.islands.save(island);
    }

    return {
      island: { id: island.id, name: island.name },
      defense_lv: defenseLv,
      attack,
      defense,
      damage,
      destroyed,
      remaining_defense_lv: Number(buildings.defense_lv ?? 0),
      narration: destroyed
        ? `你把火力压在那道临时焊起来的防线上。钢板一块块塌下去，岛上的灯灭了。`
        : `你打中了防线，但缺口很快被补上。还需要更接近，或者更强的火力。`,
      can_capture: Number(buildings.defense_lv ?? 0) <= 0,
    };
  }

  /** 开始占领：摧毁防御后连续驻留 1 世界小时 */
  async startCapture(characterId: string, islandId?: string) {
    const character = await this.must(characterId);
    const island = await this.islandFor(character, islandId);
    if (!island.owner_character_id) throw new Error('这座岛没有主人，不需要占领');
    if (island.owner_character_id === character.id) throw new Error('这已经是你的岛');
    const buildings = this.buildingsOf(island);
    if (Number(buildings.defense_lv ?? 0) > 0) throw new Error('先摧毁基地防御');
    if (buildings.capture && buildings.capture.character_id !== character.id) {
      throw new Error('已经有人在占领这座岛');
    }

    const time = await this.world.timeInfo();
    buildings.capture = {
      character_id: character.id,
      character_name: character.name,
      started_world_day: time.world_day,
      started_world_minutes: time.world_minutes,
    };
    island.buildings = buildings;
    await this.islands.save(island);
    return {
      island: { id: island.id, name: island.name },
      progress: 0,
      required_minutes: CAPTURE_MINUTES,
      narration: '你在岛中心插下自己的标记。接下来一个小时，只要没人把你赶走，这座岛就归你了。',
    };
  }

  /** 查询并结算占领进度（时间驱动，无需常驻定时器） */
  async captureStatus(characterId: string, islandId?: string) {
    const character = await this.must(characterId);
    const island = await this.islandFor(character, islandId);
    const buildings = this.buildingsOf(island);
    const capture = buildings.capture;
    if (!capture) {
      return { capturing: false, progress: 0, required_minutes: CAPTURE_MINUTES, completed: false };
    }
    const time = await this.world.timeInfo();
    const progress = captureProgress(
      Number(capture.started_world_day),
      Number(capture.started_world_minutes),
      time.world_day,
      time.world_minutes,
    );
    const completed = captureComplete(
      Number(capture.started_world_day),
      Number(capture.started_world_minutes),
      time.world_day,
      time.world_minutes,
    );

    if (!completed) {
      return {
        capturing: true,
        by: capture.character_name,
        progress,
        required_minutes: CAPTURE_MINUTES,
        remaining_minutes: CAPTURE_MINUTES - progress,
        completed: false,
      };
    }

    // 岛主若在岛上，视为防守成功
    const owner = island.owner_character_id
      ? await this.characters.findOne({ where: { id: island.owner_character_id } })
      : null;
    if (owner && owner.island_id === island.id && owner.status !== 'dead') {
      delete buildings.capture;
      island.buildings = buildings;
      await this.islands.save(island);
      return { capturing: false, progress: CAPTURE_MINUTES, required_minutes: CAPTURE_MINUTES, completed: false, failed: '岛主回来了，占领失败' };
    }

    const previousOwner = island.owner_character_id;
    island.owner_character_id = capture.character_id;
    buildings.capture = null;
    island.buildings = buildings;
    await this.islands.save(island);
    return {
      capturing: false,
      progress: CAPTURE_MINUTES,
      required_minutes: CAPTURE_MINUTES,
      completed: true,
      new_owner: capture.character_name,
      previous_owner: previousOwner,
      narration: `一个小时后，岛上原有的旗子被放倒。${capture.character_name} 成了这里的新主人。`,
    };
  }

  async cancelCapture(characterId: string): Promise<{ ok: boolean }> {
    const character = await this.must(characterId);
    const island = await this.islandFor(character);
    const buildings = this.buildingsOf(island);
    if (buildings.capture?.character_id !== character.id) throw new Error('你没有在占领这座岛');
    buildings.capture = null;
    island.buildings = buildings;
    await this.islands.save(island);
    return { ok: true };
  }

  private power(character: Character, ship: Ship | null): number {
    const shipPower = ship ? ship.weapon_power + ship.weapon_lv * 4 + ship.defense_lv * 3 : 0;
    return Math.round(6 + character.level * 5 + shipPower);
  }

  private samePlace(a: Character, b: Character): boolean {
    if (a.island_id && a.island_id === b.island_id) return true;
    if (a.island_id || b.island_id) return false;
    return distanceNm(a.x, a.y, b.x, b.y) <= 1;
  }

  private async islandFor(character: Character, islandId?: string): Promise<Island> {
    const id = islandId ?? character.island_id;
    if (!id) throw new Error('你必须先上岛');
    if (!islandId && character.island_id !== id) throw new Error('你必须先上岛');
    const island = await this.islands.findOne({ where: { id } });
    if (!island) throw new Error('岛屿不存在');
    if (character.island_id !== island.id) throw new Error('你不在岛上');
    return island;
  }

  private buildingsOf(island: Island): any {
    if (Array.isArray(island.buildings)) return {};
    return { ...(island.buildings ?? {}) };
  }

  private async dropAll(character: Character): Promise<void> {
    const items = await this.items.find({ where: { owner_type: 'character', owner_id: character.id } });
    if (items.length === 0) return;
    const state = await this.world.getState();
    const drop = await this.drops.save(
      this.drops.create({
        id: randomUUID(),
        placer_character_id: character.id,
        x: character.x,
        y: character.y,
        item_ids: items.map((item) => item.id),
        created_world_day: state.world_day,
        discovered_by: null,
      }),
    );
    for (const item of items) {
      item.owner_type = 'ground';
      item.owner_id = drop.id;
      item.x = character.x;
      item.y = character.y;
      await this.items.save(item);
    }
  }

  private async must(characterId: string): Promise<Character> {
    const character = await this.charactersService.get(characterId);
    if (!character) throw new Error('角色不存在');
    return character;
  }

  distanceText(a: Character, b: Character): string {
    return `${round1(distanceNm(a.x, a.y, b.x, b.y))} 海里`;
  }
}
