import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../database/entities/chat.entities';
import { Island, Monster } from '../database/entities/island.entities';
import { CharactersModule } from '../characters/characters.module';
import { WorldModule } from '../world/world.module';
import { IslandsModule } from '../islands/islands.module';
import { AiModule } from '../ai/ai.module';
import { MovementService } from './movement.service';

@Module({
  imports: [TypeOrmModule.forFeature([Island, Monster, Channel]), CharactersModule, WorldModule, IslandsModule, AiModule],
  providers: [MovementService],
  exports: [MovementService],
})
export class MovementModule {}
