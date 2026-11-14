import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Character, ExperienceLog, Ship, Skill, Team } from '../database/entities/character.entities';
import { Island, Monster } from '../database/entities/island.entities';
import { Crystal, DeadDrop, Item } from '../database/entities/item.entities';
import { ModerationRecord } from '../database/entities/chat.entities';
import { ModelPool, WorldEvent } from '../database/entities/world.entities';
import { AiModule } from '../ai/ai.module';
import { M4Module } from '../m4/m4.module';
import { M5Module } from '../m5/m5.module';
import { CharactersModule } from '../characters/characters.module';
import { WorldModule } from '../world/world.module';
import { AdminController } from './admin.controller';
import { ConflictService } from './conflict.service';
import { FatigueService, ProtectionService, SkillsService } from './growth.service';
import { ModelPoolService } from './model-pool.service';
import { MonsterAiService } from './monster-ai.service';
import { TeamService, TradeService } from './social.service';

/** M3：团队、PvP 夺岛、交易、技能、怪物智慧、模型池、疲劳与保护期 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Team,
      Character,
      Ship,
      Skill,
      ExperienceLog,
      Island,
      Monster,
      Item,
      Crystal,
      DeadDrop,
      WorldEvent,
      ModelPool,
      ModerationRecord,
    ]),
    CharactersModule,
    WorldModule,
    AiModule,
    M4Module,
    M5Module,
  ],
  controllers: [AdminController],
  providers: [
    TeamService,
    TradeService,
    ConflictService,
    SkillsService,
    FatigueService,
    ProtectionService,
    MonsterAiService,
    ModelPoolService,
  ],
  exports: [TeamService, TradeService, ConflictService, SkillsService, FatigueService, ProtectionService, MonsterAiService, ModelPoolService],
})
export class M3Module {}


