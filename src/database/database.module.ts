import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { IS_POSTGRES } from './column-types';
import { User } from './entities/user.entity';
import { Character, ExperienceLog, Ship, Skill, Team } from './entities/character.entities';
import { Island, IslandPoint, Monster, MonsterKind } from './entities/island.entities';
import { Crystal, DeadDrop, Item } from './entities/item.entities';
import { Channel, ChatMessage, ModerationRecord } from './entities/chat.entities';
import { AiQuota, ModelPool, ResourceRegistry, WorldEvent, WorldState } from './entities/world.entities';
import { CombatSession } from './entities/combat.entity';
import { CreatorReward, IslandRating, Report } from './entities/m4.entities';
import { SeedService } from './seed.service';

export const ALL_ENTITIES = [
  User,
  Character,
  Ship,
  Team,
  Skill,
  ExperienceLog,
  Island,
  IslandPoint,
  MonsterKind,
  Monster,
  Item,
  Crystal,
  DeadDrop,
  Channel,
  ChatMessage,
  ModerationRecord,
  WorldState,
  WorldEvent,
  ResourceRegistry,
  ModelPool,
  AiQuota,
  CombatSession,
  IslandRating,
  CreatorReward,
  Report,
];

function buildOptions() {
  const common = {
    entities: ALL_ENTITIES,
    synchronize: !IS_POSTGRES,
    logging: false as const,
    autoLoadEntities: true,
  };

  if (IS_POSTGRES) {
    return {
      type: 'postgres' as const,
      url: process.env.DATABASE_URL,
      ...common,
      // 生产/测试环境用 migrations/001-init.sql 建表，不自动改结构
      synchronize: false,
      ssl: false,
    };
  }

  const dbPath = process.env.DB_PATH || './data/drift-islands.sqlite';
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  }
  return {
    type: 'better-sqlite3' as const,
    database: dbPath,
    ...common,
  };
}

@Module({
  imports: [ConfigModule, TypeOrmModule.forRootAsync({ useFactory: buildOptions }), TypeOrmModule.forFeature(ALL_ENTITIES)],
  providers: [SeedService],
  exports: [SeedService, TypeOrmModule],
})
export class DatabaseModule {}

