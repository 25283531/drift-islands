import { afterEach, describe, expect, it } from 'vitest';
import { QuotaService } from '../../src/ai/quota.service';
import { KvService } from '../../src/redis/kv.service';

function harness() {
  const rows = new Map<string, any>();
  const key = (where: any) => `${where.user_id}|${where.real_date}`;
  const repo = {
    findOne: async ({ where }: any) => rows.get(key(where)) ?? null,
    create: (value: any) => value,
    save: async (value: any) => {
      rows.set(`${value.user_id}|${value.real_date}`, value);
      return value;
    },
  };
  return new QuotaService(repo as any, new KvService());
}

const originalBudget = process.env.AI_DAILY_BUDGET;

afterEach(() => {
  process.env.AI_DAILY_BUDGET = originalBudget;
});

describe('AI 成本配额（§4.3、§1.22）', () => {
  it('预算内允许调用，超预算标记降级', async () => {
    process.env.AI_DAILY_BUDGET = '2';
    const quota = harness();

    expect((await quota.check('u1')).allowed).toBe(true);
    await quota.record('u1');
    expect((await quota.check('u1')).allowed).toBe(true);

    await quota.record('u1');
    const status = await quota.status('u1');
    expect(status.allowed).toBe(false);
    expect(status.degraded).toBe(true);
    expect(status.used).toBe(2);
  });

  it('不同用户互不影响', async () => {
    process.env.AI_DAILY_BUDGET = '1';
    const quota = harness();
    await quota.record('a');
    expect((await quota.check('a')).allowed).toBe(false);
    expect((await quota.check('b')).allowed).toBe(true);
  });
});
