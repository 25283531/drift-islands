import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { Character } from '../database/entities/character.entities';
import { Crystal } from '../database/entities/item.entities';
import { Monster } from '../database/entities/island.entities';
import { CharactersService } from '../characters/characters.service';
import { WorldService } from '../world/world.service';
import { absorbableEnergy, applyEnergy, crystalEnergy, energyForNextLevel } from '../game/m2';

export interface AbsorbResult {
  ok: boolean;
  gained: number;
  level_before: number;
  level_after: number;
  energy: number;
  next_level_cost: number;
  remaining_in_crystal: number;
  narration: string;
}

@Injectable()
export class CrystalsService {
  constructor(
    @InjectRepository(Crystal) private readonly crystals: Repository<Crystal>,
    private readonly characters: CharactersService,
    private readonly world: WorldService,
  ) {}

  /** 怪物死亡掉落晶核（等级 = 怪物等级，能量 = 100^(N-1)），直接由击杀者收起 */
  async dropForMonster(monster: Monster, characterId: string): Promise<Crystal> {
    const level = Math.max(0, Math.min(7, monster.level));
    const energy = crystalEnergy(level);
    return this.crystals.save(
      this.crystals.create({
        id: randomUUID(),
        level,
        energy_total: energy,
        energy_remaining: energy,
        holder_type: 'character',
        holder_id: characterId,
        x: null,
        y: null,
      }),
    );
  }

  async list(characterId: string) {
    const rows = await this.crystals.find({ where: { holder_type: 'character', holder_id: characterId }, order: { level: 'DESC' } });
    return rows.map((row) => ({
      id: row.id,
      level: row.level,
      energy_remaining: Number(row.energy_remaining.toFixed(4)),
      energy_total: Number(row.energy_total.toFixed(4)),
    }));
  }

  /** 吸收：越级只吸收一部分，剩余保留在晶体中（§4.2） */
  async absorb(character: Character, crystalId: string): Promise<AbsorbResult> {
    const crystal = await this.crystals.findOne({ where: { id: crystalId } });
    if (!crystal || crystal.holder_type !== 'character' || crystal.holder_id !== character.id) {
      throw new BadRequestException('这枚晶核不在你身上');
    }
    const gain = absorbableEnergy(character.level, Number(crystal.energy_remaining));
    if (gain <= 0) throw new BadRequestException('这枚晶核的能量已经耗尽了');

    const levelBefore = character.level;
    const applied = applyEnergy(character.level, Number(character.crystal_energy), gain);
    character.level = applied.level;
    character.crystal_energy = applied.energy;
    // 升级奖励：每级提升生命上限与体力上限，回满（M2 先行数值）
    if (applied.level > levelBefore) {
      const gained = applied.level - levelBefore;
      character.max_hp += gained * 10;
      character.max_stamina += gained * 5;
      character.hp = character.max_hp;
      character.stamina = character.max_stamina;
    }
    await this.characters.save(character);

    crystal.energy_remaining = Number((crystal.energy_remaining - gain).toFixed(6));
    if (crystal.energy_remaining <= 1e-9) {
      await this.crystals.remove(crystal);
    } else {
      await this.crystals.save(crystal);
    }

    const world = await this.world.getState();
    await this.characters.recordExperience(
      character.id,
      world.world_day,
      world.world_minutes,
      'absorb',
      `吸收了 ${crystal.level} 级晶核 ${gain.toFixed(2)} 单位能量${applied.level > levelBefore ? `，升到 ${applied.level} 级` : ''}`,
    );

    const narration =
      applied.level > levelBefore
        ? `晶核在掌心碎成粉，热流顺着骨头往上走。你升到了 ${applied.level} 级，世界在眼前清楚了一层。`
        : `你把晶核贴在手背上，能量慢慢渗进去，还差 ${(
            energyForNextLevel(character.level) - character.crystal_energy
          ).toFixed(2)} 单位就能再升一级。`;

    return {
      ok: true,
      gained: Number(gain.toFixed(4)),
      level_before: levelBefore,
      level_after: character.level,
      energy: Number(character.crystal_energy.toFixed(4)),
      next_level_cost: energyForNextLevel(character.level),
      remaining_in_crystal: Number(crystal.energy_remaining.toFixed(4)),
      narration,
    };
  }
}
