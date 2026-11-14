import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get('health')
  health() {
    return { ok: true, service: 'drift-islands', milestone: 'M2', time: new Date().toISOString() };
  }
}
