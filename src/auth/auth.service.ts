import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { User } from '../database/entities/user.entity';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly jwt: JwtService,
  ) {}

  /**
   * M1 原型登录：以显示名换取会话（无密码）。
   * 生产内测前需接入正式账号体系（手机号 / 第三方），见 docs/实现说明-M1.md。
   */
  async login(displayName: string): Promise<{ token: string; user: { id: string; display_name: string; status: string } }> {
    const name = (displayName ?? '').trim();
    if (name.length < 2 || name.length > 16) {
      throw new Error('显示名长度需为 2–16 个字符');
    }
    let user = await this.users.findOne({ where: { display_name: name } });
    if (!user) {
      user = this.users.create({ id: randomUUID(), display_name: name, status: 'normal' });
      await this.users.save(user);
    }
    if (user.status === 'banned') throw new Error('该账号已被封禁');
    const token = await this.jwt.signAsync({ sub: user.id, name: user.display_name });
    return { token, user: { id: user.id, display_name: user.display_name, status: user.status } };
  }

  async verify(token: string): Promise<{ sub: string; name: string }> {
    return this.jwt.verifyAsync(token);
  }

  async getProfile(userId: string): Promise<User | null> {
    return this.users.findOne({ where: { id: userId } });
  }
}
