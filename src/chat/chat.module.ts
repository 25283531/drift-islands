import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel, ChatMessage, ModerationRecord } from '../database/entities/chat.entities';
import { User } from '../database/entities/user.entity';
import { AiModule } from '../ai/ai.module';
import { ChatService } from './chat.service';
import { ModerationService } from './moderation.service';

@Module({
  imports: [TypeOrmModule.forFeature([Channel, ChatMessage, ModerationRecord, User]), AiModule],
  providers: [ChatService, ModerationService],
  exports: [ChatService, ModerationService],
})
export class ChatModule {}
