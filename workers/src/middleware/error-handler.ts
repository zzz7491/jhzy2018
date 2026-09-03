/**
 * 全局错误处理（S2-5）。
 *
 * 纪律（用户 §七 / §十五 L）：
 * - 所有错误统一折叠为 ApiFailure 结构。
 * - 不向客户端暴露：SQL、表名、数据库路径、Secrets、内部异常 stack trace。
 * - 服务端日志（console）仅在 local 环境输出原始错误，便于本地排障；生产不输出内部细节。
 */

import type { ErrorHandler } from 'hono';
import type { Env, AppVars } from '../env';
import { AppError } from '../utils/errors';
import { fail } from '../utils/response';

export const errorHandler: ErrorHandler<{ Bindings: Env; Variables: AppVars }> = (err, c) => {
  const isLocal = (c.env.ENVIRONMENT ?? 'local') === 'local';

  if (err instanceof AppError) {
    if (isLocal) {
      // 仅本地：输出错误码便于排障（AppError 的 message 是面向客户端的安全文案）。
      console.error(`[app-error] code=${err.code} status=${err.status}`);
    }
    return fail(c, err);
  }

  // 未知异常：local 记录完整错误用于调试；客户端一律 500 INTERNAL_ERROR。
  if (isLocal) {
    console.error('[internal-error]', err instanceof Error ? err.message : String(err));
  }
  return fail(c, err); // fail() 对非 AppError 统一折叠为 internalError()。
};
