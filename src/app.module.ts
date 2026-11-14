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
import { M2Module } from './m2/m2.module';
import { M3Module } from './m3/m3.module';
import { M4Module } from './m4/m4.module';

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
    M2Module,
    M3Module,
    M4Module,
  ],
  controllers: [AppController],
})
export class AppModule {}

