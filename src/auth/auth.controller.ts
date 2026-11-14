import { Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** POST /api/v1/auth/session { display_name } → { token, user } */
  @Post('session')
  async session(@Body() body: { display_name?: string }) {
    try {
      return await this.auth.login(body?.display_name ?? '');
    } catch (err) {
      return { error: { code: 'AUTH_FAILED', message: (err as Error).message } };
    }
  }
}
