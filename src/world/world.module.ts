import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorldState } from '../database/entities/world.entities';
import { WorldController } from './world.controller';
import { WorldService } from './world.service';

@Module({
  imports: [TypeOrmModule.forFeature([WorldState])],
  controllers: [WorldController],
  providers: [WorldService],
  exports: [WorldService],
})
export class WorldModule {}
