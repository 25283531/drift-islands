import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AppController } from './app.controller';
import { DatabaseModule } from './database/database.module';
import { KvModule } from './redis/kv.module';
import { AiModule } from './ai/ai.module';
import { AuthModule } from './auth/auth.module';
import { CharactersModule } from './characters/characters.module';
import { WorldModule } from './world/world.module';
import { IslandsModule } from './islands/islands.module';
import { MovementModule } from './movement/movement.module';
import { CombatModule } from './combat/combat.module';
import { ChatModule } from './chat/chat.module';
import { GameModule } from './game/game.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    EventEmitterModule.forRoot(),
    DatabaseModule,
    KvModule,
    AiModule,
    AuthModule,
    CharactersModule,
    WorldModule,
    IslandsModule,
    MovementModule,
    CombatModule,
    ChatModule,
    GameModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
