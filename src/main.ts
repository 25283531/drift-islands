import 'dotenv/config';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: process.env.LOG_LEVEL === 'silent' ? false : ['log', 'error', 'warn'],
  });

  app.enableCors({ origin: true, credentials: true });
  app.useStaticAssets(join(__dirname, '..', 'web'));

  const port = Number.parseInt(process.env.PORT ?? '3000', 10);
  await app.listen(port, '0.0.0.0');
  const logger = new Logger('Bootstrap');
  logger.log(`漂流岛屿 M3 已启动：http://0.0.0.0:${port}`);
  logger.log(`世界时钟：${process.env.DB_TYPE === 'postgres' ? 'PostgreSQL' : 'SQLite'} · Redis: ${process.env.REDIS_URL ? 'on' : 'memory'}`);
}

void bootstrap();
