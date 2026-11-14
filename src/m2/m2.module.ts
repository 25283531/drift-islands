import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Island, IslandPoint, Monster, MonsterKind } from '../database/entities/island.entities';
import { Item, Crystal } from '../database/entities/item.entities';
import { Ship, Character } from '../database/entities/character.entities';
import { Channel } from '../database/entities/chat.entities';
import { ResourceRegistry } from '../database/entities/world.entities';
import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { CharactersModule } from '../characters/characters.module';
import { WorldModule } from '../world/world.module';
import { IslandsModule } from '../islands/islands.module';
import { ResourceRegistryService } from '../resources/resource-registry.service';
import { IslandCreateService } from '../islands/island-create.service';
import { CollectService } from '../collect/collect.service';
import { ShipsService, ShipsController } from '../ships/ships.service';
import { CrystalsService } from '../crystals/crystals.service';
import { GarrisonService, GarrisonController } from '../garrison/garrison.service';
import { IslandCreateController } from '../islands/island-create.controller';

/** M2：造岛、收集裁决、资源注册表、船只升级、晶核、驻扎基地 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Island, IslandPoint, Monster, MonsterKind, Item, Crystal, Channel, ResourceRegistry, Ship, Character]),
    AiModule,
    AuthModule,
    CharactersModule,
    WorldModule,
    IslandsModule,
  ],
  controllers: [ShipsController, GarrisonController, IslandCreateController],
  providers: [ResourceRegistryService, IslandCreateService, CollectService, ShipsService, CrystalsService, GarrisonService],
  exports: [ResourceRegistryService, IslandCreateService, CollectService, ShipsService, CrystalsService, GarrisonService],
})
export class M2Module {}
