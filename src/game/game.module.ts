import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CharactersModule } from '../characters/characters.module';
import { ChatModule } from '../chat/chat.module';
import { CombatModule } from '../combat/combat.module';
import { IslandsModule } from '../islands/islands.module';
import { MovementModule } from '../movement/movement.module';
import { AiModule } from '../ai/ai.module';
import { WorldModule } from '../world/world.module';
import { M2Module } from '../m2/m2.module';
import { M3Module } from '../m3/m3.module';
import { M4Module } from '../m4/m4.module';
import { M5Module } from '../m5/m5.module';
import { GameGateway } from './game.gateway';

@Module({
  imports: [AuthModule, CharactersModule, ChatModule, CombatModule, IslandsModule, MovementModule, AiModule, WorldModule, M2Module, M3Module, M4Module, M5Module],
  providers: [GameGateway],
  exports: [GameGateway],
})
export class GameModule {}


