import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { io, Socket } from 'socket.io-client';
import { AppModule } from '../../src/app.module';
import { Island } from '../../src/database/entities/island.entities';
import { FIXED_IDS } from '../../src/database/seed.service';

export interface Harness {
  app: INestApplication;
  port: number;
  baseUrl: string;
  island: Island;
}

export async function createHarness(): Promise<Harness> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0);
  const address = app.getHttpServer().address();
  const port = typeof address === 'object' && address ? address.port : 3000;
  const ds = app.get(DataSource);
  const island = (await ds.getRepository(Island).findOne({ where: { id: FIXED_IDS.PRESET_ISLAND } }))!;
  return { app, port, baseUrl: `http://127.0.0.1:${port}`, island };
}

export async function jsonFetch(baseUrl: string, path: string, options: any = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  return res.json();
}

export async function loginAndCreateCharacter(baseUrl: string, displayName: string, characterName: string) {
  const session = await jsonFetch(baseUrl, '/api/v1/auth/session', {
    method: 'POST',
    body: JSON.stringify({ display_name: displayName }),
  });
  if (!session.token) throw new Error(`登录失败：${JSON.stringify(session)}`);
  const created = await jsonFetch(baseUrl, '/api/v1/characters', {
    method: 'POST',
    headers: { authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ name: characterName }),
  });
  if (!created.character) throw new Error(`建角失败：${JSON.stringify(created)}`);
  return { token: session.token as string, character: created.character, ship: created.ship };
}

export function connectSocket(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    const timer = setTimeout(() => reject(new Error('socket 连接超时')), 6000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function authSocket(socket: Socket, token: string, characterId: string): Promise<any> {
  const authenticated = waitFor(socket, 'authenticated', undefined, 6000);
  socket.emit('auth', { token, character_id: characterId });
  return authenticated;
}

export function waitFor(
  socket: Socket,
  event: string,
  predicate?: (payload: any) => boolean,
  timeoutMs = 6000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`等待事件超时：${event}`));
    }, timeoutMs);
    const handler = (payload: any) => {
      if (predicate && !predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

/** 收集一段时间内的事件（用于“应该没有响应”的断言） */
export async function collect(socket: Socket, event: string, durationMs = 600): Promise<any[]> {
  const items: any[] = [];
  const handler = (payload: any) => items.push(payload);
  socket.on(event, handler);
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  socket.off(event, handler);
  return items;
}

export function angleTo(from: { x: number; y: number }, to: { x: number; y: number }): number {
  return (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
}

export async function closeHarness(harness: Harness, sockets: Socket[] = []): Promise<void> {
  for (const socket of sockets) socket.close();
  await harness.app.close();
}
