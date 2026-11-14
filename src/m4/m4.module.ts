import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Character } from '../database/entities/character.entities';
import { ChatMessage } from '../database/entities/chat.entities';
import { Island } from '../database/entities/island.entities';
import { CreatorReward, IslandRating, Report } from '../database/entities/m4.entities';
import { AuthModule } from '../auth/auth.module';
import { ChatModule } from '../chat/chat.module';
import { WorldModule } from '../world/world.module';
import { IncentiveService } from './incentive.service';
import { M4Controller } from './m4.controller';
import { RatingService } from './rating.service';
import { ReportService } from './report.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Island, IslandRating, CreatorReward, Report, ChatMessage, Character]),
    ChatModule,
    AuthModule,
    WorldModule,
  ],
  controllers: [M4Controller],
  providers: [RatingService, IncentiveService, ReportService],
  exports: [RatingService, IncentiveService, ReportService],
})
export class M4Module {}

