/**
 * FileRepository（P33-P3A-2）—— files 表（TEAM_SCOPED，R2 元数据）。
 *
 * scope 事实（S2-3 矩阵 / tenant-scope.ts）：files = TEAM_SCOPED。
 *
 * 纪律：
 * - 所有查询必须带 team_id 且 deleted_at IS NULL；跨团队一律按 not found 处理（不泄露存在性）。
 * - numeric id（files.id / team_id / uploader_id）只允许出现在 DB 层与 service 内部，
 *   绝不进入 API 响应（响应只走 service 的 safe view）。
 * - 禁止字符串拼接 SQL；全部 prepare().bind()。
 */

import { BaseRepository, type RepoDeps } from './base';

export interface FileRow {
  id: number;
  public_id: string;
  team_id: number;
  uploader_id: number | null;
  original_name: string | null;
  object_key: string;
  mime_type: string;
  size_bytes: number;
  checksum: string | null;
  visibility: string;
  exif_stripped: number;
  scan_status: number;
  created_at: number;
  deleted_at: number | null;
}

/** 附件解析所需的最小投影（不含 object_key，避免向 service 上层扩散内部 key）。 */
export interface FileAttachmentRow {
  id: number;
  public_id: string;
  uploader_id: number | null;
  mime_type: string;
  size_bytes: number;
  visibility: string;
}

export interface InsertFileMetadataInput {
  publicId: string;
  teamId: number;
  uploaderId: number | null;
  originalName: string;
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  visibility: string;
}

export class FileRepository extends BaseRepository {
  /** 取团队 public_id（用于 object key 分片；不得把 numeric team id 写进 key）。 */
  async getTeamPublicId(teamId: number): Promise<string | null> {
    this.ensureTableRead('files');
    const row = await this.first<{ public_id: string }>(
      'SELECT public_id FROM teams WHERE id = ? AND deleted_at IS NULL',
      [teamId],
    );
    return row?.public_id ?? null;
  }

  /** 按 public_id + team 读取（TEAM 边界 + 未软删）。 */
  async findByPublicIdAndTeam(publicId: string, teamId: number): Promise<FileRow | null> {
    this.ensureTableRead('files');
    return this.first<FileRow>(
      `SELECT id, public_id, team_id, uploader_id, original_name, object_key, mime_type,
              size_bytes, checksum, visibility, exif_stripped, scan_status, created_at, deleted_at
         FROM files
        WHERE public_id = ? AND team_id = ? AND deleted_at IS NULL`,
      [publicId, teamId],
    );
  }

  /**
   * 附件解析：把客户端提交的 file public_id 列表解析为内部行。
   * - 强制 team_id + deleted_at IS NULL；缺失的 public_id 直接不返回（由 service 判定 404）。
   * - 不返回 object_key（内部 key 不得扩散到 service 之上）。
   */
  async resolveForAttachment(publicIds: string[], teamId: number): Promise<FileAttachmentRow[]> {
    this.ensureTableRead('files');
    if (publicIds.length === 0) return [];
    const placeholders = publicIds.map(() => '?').join(',');
    return this.all<FileAttachmentRow>(
      `SELECT id, public_id, uploader_id, mime_type, size_bytes, visibility
         FROM files
        WHERE public_id IN (${placeholders}) AND team_id = ? AND deleted_at IS NULL`,
      [...publicIds, teamId],
    );
  }

  /**
   * 写入文件元数据（D1 侧；R2 put 已在 service 中先完成）。
   * 返回内部 numeric id（仅 DB 层使用）。
   */
  async insertFileMetadata(input: InsertFileMetadataInput): Promise<number> {
    this.ensureTableRead('files');
    const res = await this.run(
      `INSERT INTO files (public_id, team_id, uploader_id, original_name, object_key, mime_type,
                          size_bytes, checksum, visibility, exif_stripped, scan_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, unixepoch())`,
      [
        input.publicId,
        input.teamId,
        input.uploaderId,
        input.originalName,
        input.objectKey,
        input.mimeType,
        input.sizeBytes,
        input.checksum,
        input.visibility,
      ],
    );
    const id = (res as { meta?: { last_row_id?: number | string } } | null)?.meta?.last_row_id;
    return Number(id ?? 0);
  }
}

/** 便捷构造（与其它 repository 的 deps 形态一致）。 */
export function createFileRepository(deps: RepoDeps): FileRepository {
  return new FileRepository(deps);
}
