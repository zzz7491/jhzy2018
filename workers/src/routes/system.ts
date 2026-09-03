/**
 * GET /api/v2/system/status —— 系统状态（S2-5）。
 *
 * 仅返回非敏感运行状态：不暴露 database_id / secrets / 内部路径。
 * 平台级资源（PLATFORM_GLOBAL 语义）：不要求 team 上下文。
 */

import { Hono } from 'hono';
import type { Env, AppVars } from '../env';
import { ok } from '../utils/response';

const system = new Hono<{ Bindings: Env; Variables: AppVars }>();

system.get('/status', async (c) => {
  let d1Ok = false;
  let migrationsApplied: number | null = null;
  try {
    const r = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM d1_migrations').first<{ n: number }>();
    d1Ok = true;
    migrationsApplied = r?.n ?? 0;
  } catch {
    d1Ok = false;
  }

  return ok(c, {
    status: 'ok',
    api_version: 'v2',
    worker: 'jhzy-v2-worker',
    environment: c.env.ENVIRONMENT ?? 'local',
    d1: { binding: d1Ok ? 'present' : 'error', migrations_applied: migrationsApplied },
    time: Math.floor(Date.now() / 1000),
  });
});

export default system;
