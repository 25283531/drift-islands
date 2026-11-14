import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CombatSession } from '../database/entities/combat.entity';
import { Monster } from '../database/entities/island.entities';
import { Item } from '../database/entities/item.entities';
import { CharactersModule } from '../characters/characters.module';
import { WorldModule } from '../world/world.module';
import { AiModule } from '../ai/ai.module';
import { CombatService } from './combat.service';

@Module({
  imports: [TypeOrmModule.forFeature([CombatSession, Monster, Item]), CharactersModule, WorldModule, AiModule],
  providers: [CombatService],
  exports: [CombatService],
})
export class CombatModule {}
