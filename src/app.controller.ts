import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get('health')
  health() {
    return { ok: true, service: 'drift-islands', milestone: 'M5-prep', time: new Date().toISOString() };
  }
}

