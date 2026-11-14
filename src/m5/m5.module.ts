import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { AiQuota } from '../database/entities/world.entities';
import { Character } from '../database/entities/character.entities';
import { ChatMessage, ModerationRecord } from '../database/entities/chat.entities';
import { CombatSession } from '../database/entities/combat.entity';
import { Island } from '../database/entities/island.entities';
import { Feedback } from '../database/entities/m5.entities';
import { Report } from '../database/entities/m4.entities';
import { FeedbackService } from './feedback.service';
import { MetricsService } from './metrics.service';
import { M5Controller } from './m5.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([Feedback, Character, Island, CombatSession, AiQuota, ModerationRecord, Report, ChatMessage]),
    AuthModule,
  ],
  controllers: [M5Controller],
  providers: [FeedbackService, MetricsService],
  exports: [FeedbackService, MetricsService],
})
export class M5Module {}
