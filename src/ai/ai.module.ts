import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiQuota } from '../database/entities/world.entities';
import { AiGatewayService } from './ai-gateway.service';
import { ContentFilterService } from './content-filter.service';
import { NarratorService } from './narrator.service';
import { QuotaService } from './quota.service';

@Module({
  imports: [TypeOrmModule.forFeature([AiQuota])],
  providers: [ContentFilterService, AiGatewayService, QuotaService, NarratorService],
  exports: [ContentFilterService, AiGatewayService, QuotaService, NarratorService],
})
export class AiModule {}
