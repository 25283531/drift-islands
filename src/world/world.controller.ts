import { Controller, Get } from '@nestjs/common';
import { WorldService } from './world.service';

@Controller('api/v1/world')
export class WorldController {
  constructor(private readonly world: WorldService) {}

  @Get()
  async state() {
    const state = await this.world.getState();
    const info = this.world.infoOf(state);
    return {
      world_day: info.world_day,
      world_minutes: info.world_minutes,
      world_hour: info.world_hour,
      day_night: info.day_night,
      text: info.text,
      sea_radius_nm: state.sea_radius_nm,
      island_count: state.island_count,
      current_direction: state.current_direction,
      /** 现实秒 → 世界分钟换算，供前端显示时钟速度 */
      seconds_per_world_minute: 20,
    };
  }
}
