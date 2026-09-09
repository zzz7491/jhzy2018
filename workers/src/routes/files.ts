/**
 * 文件路由（P33-P3A-2）—— /api/v2/files
 *
 * POST /api/v2/files
 *   - requirePermission('file.file.upload')（已授予 volunteer / platform_* / team_owner / team_admin）
 *   - 要求 authenticated + active TEAM（service 二次确认：teamScopeRequired）
 *   - multipart/form-data：file（必填，单文件）、purpose（可选，仅 community_attachment）
 *   - 201 + 严格 6 字段 safe view
 *
 * GET /api/v2/files/:filePublicId
 *   - requirePermission('file.file.view')
 *   - ULID 校验 + TEAM scoped（public_id + auth.teamId + deleted_at IS NULL）；跨团队 404
 *   - visibility: team → 同团队；private → uploader 本人 / platform_super_admin；public → V1 不服务
 *   - R2 对象缺失 → 404
 *   - 响应头：Content-Type（allowlist MIME）/ nosniff / inline / private, no-store
 *   - 不返回 object_key / bucket / checksum / 任何 numeric id
 */

import { Hono } from 'hono';
import type { Env, AppVars } from '../env';
import { FileService } from '../services/file-service';
import { requirePermission } from '../middleware/rbac';
import { ok } from '../utils/response';
import { invalidParam } from '../utils/errors';
import { MAX_FILE_SIZE } from '../utils/file-policy';

const files = new Hono<{ Bindings: Env; Variables: AppVars }>();

/** multipart 包装开销余量：预检只用于"提前拒绝明显超大的请求"，精确判定在 service。 */
const MULTIPART_OVERHEAD_ALLOWANCE = 8192;

/** Content-Length 预检（在读取 body 之前拒绝超大请求）。 */
function preCheckContentLength(raw: string | undefined): void {
  if (raw == null || raw === '') return; // 缺失（chunked）→ 交由 service 精确判定
  const len = Number(raw);
  if (!Number.isFinite(len)) throw invalidParam('file', 'file_too_large');
  if (len > MAX_FILE_SIZE + MULTIPART_OVERHEAD_ALLOWANCE) {
    throw invalidParam('file', 'file_too_large');
  }
}

files.post('/', requirePermission('file.file.upload'), async (c) => {
  preCheckContentLength(c.req.header('content-length'));

  // Hono 4.x parseBody 支持 multipart/form-data，文件字段返回 File 对象。
  const body = await c.req.parseBody();
  const file = body['file'];
  const purpose = body['purpose'];

  const svc = new FileService({
    db: c.env.DB,
    bucket: c.env.FILES,
    auth: c.get('auth'),
    tenant: c.get('tenant'),
    env: { ENVIRONMENT: c.env.ENVIRONMENT, JHZY_FAULT_INJECT: c.env.JHZY_FAULT_INJECT },
  });
  const view = await svc.uploadCommunityImage(file, purpose);
  return ok(c, view, 201);
});

files.get('/:filePublicId', requirePermission('file.file.view'), async (c) => {
  const filePublicId = c.req.param('filePublicId');
  const svc = new FileService({
    db: c.env.DB,
    bucket: c.env.FILES,
    auth: c.get('auth'),
    tenant: c.get('tenant'),
    env: { ENVIRONMENT: c.env.ENVIRONMENT, JHZY_FAULT_INJECT: c.env.JHZY_FAULT_INJECT },
  });
  const { body, mimeType } = await svc.getFileStream(filePublicId);

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': mimeType,
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
});

export default files;
