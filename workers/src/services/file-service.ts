/**
 * FileService（P33-P3A-2）—— 本地 2.0 文件基础设施（R2 + D1，TEAM_SCOPED）。
 *
 * 冻结依据：P33-P3A-1（FILE_INFRA_DESIGN = FROZEN）+ P33-P3A-2 实现指令。
 *
 * 上传流程（严格按序，不可调换）：
 *   1) auth / active TEAM 由 route + middleware 确认（本 service 二次确认）
 *   2) 校验 File 存在与体积（<= 5 MiB）
 *   3) magic bytes 判定真实类型（MIME 与扩展名只由 magic 推导）
 *   4) sha256（落 checksum，不返回客户端）
 *   5) 生成 ULID（public_id）
 *   6) 构造 object key：community/{teamPublicId}/{yyyy}/{mm}/{filePublicId}.{ext}
 *   7) R2 put
 *   8) D1 insert（scan_status=0 / exif_stripped=0 / visibility='team'）
 *   9) D1 失败 → best-effort R2 delete（补偿）；补偿失败仅记录内部日志，不回显 object_key
 *  10) 返回 safe view（6 字段白名单）
 *
 * 边界纪律：
 * - team_id = tenant.teamId、uploader_id = auth.userId，绝不来自客户端。
 * - numeric id / object_key / checksum / bucket 一律不得出现在返回值中。
 * - 不新增 files 状态列；R2 与 D1 无跨服务事务，采用「R2 优先 + 补偿 + 读路径以 D1 为权威」。
 */

import { FileRepository } from '../repository/files';
import type { AuthContext } from '../types/auth';
import type { TenantContext } from '../types/tenant';
import { generateUlid, sha256HexBytes } from '../utils/crypto';
import {
  MAX_FILE_SIZE,
  SCAN_STATUS,
  EXIF_STATUS,
  FILE_VISIBILITY,
  ALLOWED_FILE_PURPOSES,
  detectImageType,
  isAllowedImageMime,
  sanitizeOriginalName,
  buildObjectKey,
} from '../utils/file-policy';
import { isUlid } from '../utils/validation';
import { authRequired, invalidParam, internalError, notFound, teamScopeRequired } from '../utils/errors';

/** 上传成功后的安全视图（严格 6 字段）。 */
export interface FileSafeView {
  file_public_id: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  visibility: string;
  scan_status: number;
}

/** 下载结果（body 直接透传给 Response）。 */
export interface FileStreamResult {
  body: ReadableStream<Uint8Array>;
  mimeType: string;
  sizeBytes: number;
}

export interface FileServiceEnv {
  ENVIRONMENT?: string;
  JHZY_FAULT_INJECT?: string;
}

export interface FileServiceDeps {
  db: D1Database;
  bucket: R2Bucket;
  auth: AuthContext;
  tenant: TenantContext;
  env?: FileServiceEnv;
}

/** magic bytes 读取长度（最长签名为 WEBP，需 12 字节；取 16 留余量）。 */
const MAGIC_HEAD_BYTES = 16;

export class FileService {
  private readonly repo: FileRepository;
  private readonly bucket: R2Bucket;
  private readonly auth: AuthContext;
  private readonly tenant: TenantContext;
  private readonly env: FileServiceEnv;

  constructor(deps: FileServiceDeps) {
    this.repo = new FileRepository({
      db: deps.db,
      ctx: { auth: deps.auth, tenant: deps.tenant },
    });
    this.bucket = deps.bucket;
    this.auth = deps.auth;
    this.tenant = deps.tenant;
    this.env = deps.env ?? {};
  }

  // ===== 内部：身份 / 团队边界 =====

  private requireActor(): { userId: number; teamId: number } {
    if (!this.auth.authenticated || this.auth.userId == null) throw authRequired();
    if (this.tenant.teamId == null) throw teamScopeRequired();
    return { userId: this.auth.userId, teamId: this.tenant.teamId };
  }

  /**
   * local-only 故障注入（沿用既有 S2-6i/P32 约定：仅 ENVIRONMENT==='local' 且显式取值时生效）。
   * - '3' → 强制 D1 insert 失败（R2 put 已成功）→ 用于验证补偿 delete
   * - '4' → 强制补偿 delete 失败（验证补偿失败不影响 500 响应与数据一致性）
   * 非 local 一律返回 'none'，无任何副作用。
   */
  private faultMode(): 'none' | 'd1_fail' | 'compensate_fail' {
    if ((this.env.ENVIRONMENT ?? 'local') !== 'local') return 'none';
    if (this.env.JHZY_FAULT_INJECT === '3') return 'd1_fail';
    if (this.env.JHZY_FAULT_INJECT === '4') return 'compensate_fail';
    return 'none';
  }

  /** 内部日志：只记事件与是否存在 key，绝不打印 object_key 本体。 */
  private logInternal(event: string, detail: Record<string, unknown> = {}): void {
    console.error(JSON.stringify({ level: 'error', tag: 'P33_FILE', event, ...detail }));
  }

  // ===== 上传 =====

  /**
   * Community V1 图片上传。
   * @param file multipart 中的文件（route 层解析后传入）
   * @param purpose 可选；若提供必须恰好为 'community_attachment'
   */
  async uploadCommunityImage(file: unknown, purpose?: unknown): Promise<FileSafeView> {
    const { userId, teamId } = this.requireActor();

    // ① purpose 校验（V1 白名单单点；files 表无 purpose 列，不落库）。
    if (purpose !== undefined && purpose !== null && purpose !== '') {
      if (typeof purpose !== 'string' || !ALLOWED_FILE_PURPOSES.includes(purpose)) {
        throw invalidParam('purpose', 'purpose_invalid');
      }
    }

    // ② File 校验。
    if (!(file instanceof File)) throw invalidParam('file', 'file_required');
    if (file.size <= 0) throw invalidParam('file', 'file_required');
    if (file.size > MAX_FILE_SIZE) throw invalidParam('file', 'file_too_large');

    // ③ magic bytes（真实类型唯一来源）。
    const buffer = await file.arrayBuffer();
    if (buffer.byteLength > MAX_FILE_SIZE) throw invalidParam('file', 'file_too_large');
    const head = new Uint8Array(buffer.slice(0, MAGIC_HEAD_BYTES));
    const detected = detectImageType(head);
    if (detected == null) throw invalidParam('file', 'unsupported_image_type');
    // 客户端声明的 MIME 若在允许列表内，必须与 magic 结果一致（防止伪装）。
    const declared = typeof file.type === 'string' ? file.type.toLowerCase() : '';
    if (declared !== '' && declared !== detected.mime) {
      throw invalidParam('file', 'unsupported_image_type');
    }

    // ④ sha256（内部 checksum，不返回）。
    const checksum = await sha256HexBytes(new Uint8Array(buffer));

    // ⑤ / ⑥ public_id + object key（不含 numeric id / 原始文件名 / 客户端输入）。
    const publicId = generateUlid();
    const teamPublicId = await this.repo.getTeamPublicId(teamId);
    if (teamPublicId == null || !isUlid(teamPublicId)) {
      // 团队不存在（极端并发/数据异常）：不落任何 R2 对象。
      throw teamScopeRequired();
    }
    const objectKey = buildObjectKey({ teamPublicId, filePublicId: publicId, ext: detected.ext });
    const originalName = sanitizeOriginalName(file.name);

    // ⑦ R2 put（先写对象；无 DB 行的对象永不可达）。
    await this.bucket.put(objectKey, buffer, {
      httpMetadata: { contentType: detected.mime },
    });

    // ⑧ D1 insert。
    if (this.faultMode() === 'd1_fail') {
      await this.compensate(objectKey, 'd1_insert_fault_injected');
      throw internalError();
    }
    try {
      await this.repo.insertFileMetadata({
        publicId,
        teamId,
        uploaderId: userId,
        originalName,
        objectKey,
        mimeType: detected.mime,
        sizeBytes: buffer.byteLength,
        checksum,
        visibility: FILE_VISIBILITY.TEAM,
      });
    } catch (err) {
      // ⑨ 补偿：best-effort R2 delete（失败只记内部日志，不改变对外响应）。
      await this.compensate(objectKey, 'd1_insert_failed');
      this.logInternal('upload_d1_failed', {
        reason: err instanceof Error ? err.name : 'unknown',
        object_key_present: true,
      });
      throw internalError();
    }

    // ⑩ safe view。
    return {
      file_public_id: publicId,
      original_name: originalName,
      mime_type: detected.mime,
      size_bytes: buffer.byteLength,
      visibility: FILE_VISIBILITY.TEAM,
      scan_status: SCAN_STATUS.NOT_SCANNED,
    };
  }

  /** best-effort 删除已写入 R2 的对象；失败只记日志（不抛、不改响应）。 */
  private async compensate(objectKey: string, reason: string): Promise<void> {
    try {
      if (this.faultMode() === 'compensate_fail') {
        throw new Error('fault_injected_compensate_fail');
      }
      await this.bucket.delete(objectKey);
      this.logInternal('compensate_delete_ok', { reason, object_key_present: true });
    } catch (err) {
      this.logInternal('compensate_delete_failed', {
        reason,
        detail: err instanceof Error ? err.name : 'unknown',
        object_key_present: true,
      });
    }
  }

  // ===== 下载 =====

  /**
   * TEAM-scoped 文件读取。
   * - public_id + teamId + deleted_at IS NULL；跨团队 → 404（不泄露存在性）。
   * - visibility: team → 同团队可读；private → 仅 uploader 本人 / platform_super_admin；
   *   public → V1 不创建，遇到也按 404 处理（不因 public 绕过 TEAM 边界）。
   * - R2 对象缺失 → 404（不回显 object_key / bucket）。
   */
  async getFileStream(filePublicId: string): Promise<FileStreamResult> {
    if (!isUlid(filePublicId)) throw notFound('File');
    const { userId, teamId } = this.requireActor();

    const row = await this.repo.findByPublicIdAndTeam(filePublicId, teamId);
    if (row == null) throw notFound('File');

    if (row.visibility === FILE_VISIBILITY.PRIVATE) {
      const isSelf = row.uploader_id != null && row.uploader_id === userId;
      const isSuper = this.auth.roles.some((b) => b.role === 'platform_super_admin');
      if (!isSelf && !isSuper) throw notFound('File');
    } else if (row.visibility !== FILE_VISIBILITY.TEAM) {
      // public / 未知取值：V1 不服务。
      throw notFound('File');
    }

    if (!isAllowedImageMime(row.mime_type)) throw notFound('File');

    const object = await this.bucket.get(row.object_key);
    if (object == null || object.body == null) {
      this.logInternal('r2_object_missing', { file_public_id: filePublicId });
      throw notFound('File');
    }

    return {
      body: object.body as ReadableStream<Uint8Array>,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
    };
  }
}

/** exif 语义常量导出（供测试/文档引用，确保"未剥离"语义不被误写）。 */
export const EXIF_NOT_STRIPPED = EXIF_STATUS.NOT_STRIPPED;
