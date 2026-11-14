import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    testTimeout: 40000,
    hookTimeout: 40000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    env: {
      NODE_ENV: 'test',
      DB_TYPE: 'sqlite',
      DB_PATH: ':memory:',
      JWT_SECRET: 'test-secret',
      AI_API_KEY: '',
      AI_BASE_URL: '',
      AI_DAILY_BUDGET: '200',
      COMBAT_ROUND_MS: '1500',
      WORLD_TICK_MS: '600000',
      LOG_LEVEL: 'silent',
    },
  },
});
