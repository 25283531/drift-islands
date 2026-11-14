import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { Character } from '../database/entities/character.entities';
import { Island, Monster } from '../database/entities/island.entities';
import { Item } from '../database/entities/item.entities';
import { ResourceRegistryService } from '../resources/resource-registry.service';
import { CharactersService } from '../characters/characters.service';
import { WorldService } from '../world/world.service';
import { collectAmount, collectChance } from '../game/m2';

export interface CollectResult {
  ok: boolean;
  outcome: 'success' | 'failure' | 'nothing';
  category: string;
  amount: number;
  chance: number;
  roll: number;
  stamina_cost: number;
  damage: number;
  narration: string;
  items?: { name: string; type: string; quantity: number }[];
}

@Injectable()
export class CollectService {
  constructor(
    @InjectRepository(Item) private readonly items: Repository<Item>,
    @InjectRepository(Monster) private readonly monsters: Repository<Monster>,
    @InjectRepository(Island) private readonly islands: Repository<Island>,
    private readonly resources: ResourceRegistryService,
    private readonly characters: CharactersService,
    private readonly world: WorldService,
  ) {}

  /**
   * 收集裁决（§4.2）：意图提取 → 数字判定 → 叙述。
   * 判定结果由本方法固定，AI 只负责措辞，不能改写成功 / 失败与数量。
   */
  async collect(character: Character, islandId: string, intent: string): Promise<CollectResult> {
    const island = await this.islands.findOne({ where: { id: islandId } });
    if (!island) throw new Error('这座岛不存在');
    if (character.island_id !== islandId) throw new Error('你不在岛上');

    const target = await this.resources.classify(intent || island.resource_direction || '杂物');
    const pool = await this.items.find({
      where: { owner_type: 'island', owner_id: islandId, type: target.category, quantity: MoreThan(0) },
      order: { quantity: 'DESC' },
    });
    const fallback = pool.length === 0
      ? await this.items.find({ where: { owner_type: 'island', owner_id: islandId, quantity: MoreThan(0) } })
      : [];

    if (pool.length === 0 && fallback.length === 0) {
      return {
        ok: true,
        outcome: 'nothing',
        category: target.category,
        amount: 0,
        chance: 0,
        roll: 0,
        stamina_cost: 1,
        damage: 0,
        narration: '你把这一片翻了个遍，只找到咸味的泥和碎贝壳。岛上的资源已经被拿空了。',
      };
    }

    const stack = (pool[0] ?? fallback[0]) as Item;
    const alive = await this.monsters.find({ where: { island_id: islandId } });
    const monstersAlive = alive.some((monster) => monster.state !== 'dead');
    const chance = collectChance({
      characterLevel: character.level,
      islandMaxLevel: island.max_monster_level,
      researchLv: 0,
      monstersAlive,
    });
    const roll = Math.random();
    const world = await this.world.getState();

    if (roll >= chance) {
      character.stamina = Math.max(0, character.stamina - 5);
      await this.characters.save(character);
      await this.characters.recordExperience(
        character.id,
        world.world_day,
        world.world_minutes,
        'collect_fail',
        `在「${island.name}」尝试收集${stack.name}失败`,
      );
      return {
        ok: true,
        outcome: 'failure',
        category: stack.type,
        amount: 0,
        chance,
        roll: Number(roll.toFixed(4)),
        stamina_cost: 5,
        damage: 0,
        narration: `你伸手去够${stack.name}，脚下的锈板忽然塌了一块。东西没拿到，只惊起一片灰。`,
      };
    }

    const amount = Math.min(stack.quantity, collectAmount({ researchLv: 0, islandMaxLevel: island.max_monster_level, roll }));
    stack.quantity -= amount;
    await this.items.save(stack);

    let carried = await this.items.findOne({
      where: { owner_type: 'character', owner_id: character.id, name: stack.name, type: stack.type },
    });
    if (!carried) {
      carried = this.items.create({
        id: randomUUID(),
        name: stack.name,
        type: stack.type,
        tags: stack.tags,
        quantity: amount,
        condition: stack.condition,
        owner_type: 'character',
        owner_id: character.id,
        x: character.x,
        y: character.y,
      });
    } else {
      carried.quantity += amount;
    }
    await this.items.save(carried);

    island.resources_taken += amount;
    await this.islands.save(island);

    character.stamina = Math.max(0, character.stamina - 2);
    await this.characters.save(character);
    await this.characters.recordExperience(
      character.id,
      world.world_day,
      world.world_minutes,
      'collect',
      `在「${island.name}」收集到 ${amount} 份${stack.name}`,
    );

    return {
      ok: true,
      outcome: 'success',
      category: stack.type,
      amount,
      chance,
      roll: Number(roll.toFixed(4)),
      stamina_cost: 2,
      damage: 0,
      narration: `你从${island.name}的缝隙里掏出 ${amount} 份${stack.name}，塞进背包。手上的锈味一时洗不掉。`,
      items: [{ name: stack.name, type: stack.type, quantity: amount }],
    };
  }
}
