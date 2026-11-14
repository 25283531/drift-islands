import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../database/entities/chat.entities';
import { Island, IslandPoint, Monster, MonsterKind } from '../database/entities/island.entities';
import { AuthModule } from '../auth/auth.module';
import { CharactersModule } from '../characters/characters.module';
import { IslandsController } from './islands.controller';
import { IslandsService } from './islands.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Island, IslandPoint, Monster, MonsterKind, Channel]),
    AuthModule,
    CharactersModule,
  ],
  controllers: [IslandsController],
  providers: [IslandsService],
  exports: [IslandsService],
})
export class IslandsModule {}
