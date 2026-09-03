import { Hono } from 'hono';
import type { Env, AppVars } from '../env';

/**
 * GET /health —— 最小健康检查。
 *
 * 仅返回非敏感状态：worker 状态 / D1 binding 是否存在 / 当前环境 / schema(migration) 状态。
 * 禁止返回：database_id / secrets / token / 环境变量 / 内部路径。
 */
const health = new Hono<{ Bindings: Env; Variables: AppVars }>();

health.get('/', async (c) => {
  const env = c.env.ENVIRONMENT ?? 'local';

  let d1Ok = false;
  let migrationCount: number | null = null;
  try {
    const r = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM d1_migrations')
      .first<{ n: number }>();
    d1Ok = true;
    migrationCount = r?.n ?? 0;
  } catch {
    d1Ok = false;
  }

  return c.json({
    status: 'ok',
    worker: 'jhzy-v2-worker',
    environment: env,
    d1Binding: d1Ok ? 'present' : 'error',
    schema: { migrationsApplied: migrationCount },
    time: Math.floor(Date.now() / 1000),
  });
});

export default health;
