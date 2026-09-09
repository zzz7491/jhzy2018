/**
 * 文件策略（P33-P3A-2）—— Community V1 图片上传的唯一策略事实来源。
 *
 * 冻结依据：P33-P3A-1（FILE_INFRA_DESIGN = FROZEN）。
 *
 * 纪律：
 * - 允许列表仅 image/jpeg / image/png / image/webp；gif / heic / heif / svg+xml 与其它全部拒绝。
 * - MIME 判定以【magic bytes】为准；客户端声明的 MIME 与扩展名只作交叉校验，不作信任源。
 * - object key 的扩展名只能由 magic bytes 推导，绝不使用 original filename。
 * - original_name 仅作 metadata，必须 sanitize，绝不参与 object key。
 * - 不提供任何解码 / 重编码 / EXIF 剥离能力（Workers 侧当前无相关依赖），
 *   因此 exif_stripped 恒为 0，语义 = NOT_STRIPPED（禁止伪报 1）。
 */

/** 允许的 MIME（Community V1）。 */
export const ALLOWED_IMAGE_MIME: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];

/** 单文件上限：5 MiB。 */
export const MAX_FILE_SIZE = 5 * 1024 * 1024;

/** Community V1 单篇文章最大图片数（附件解析阶段使用）。 */
export const MAX_IMAGES_PER_POST = 9;

/** Community V1 上传用途白名单（files 表无 purpose 列，V1 不落库，仅作入口校验）。 */
export const FILE_PURPOSE_COMMUNITY_ATTACHMENT = 'community_attachment';
export const ALLOWED_FILE_PURPOSES: readonly string[] = [FILE_PURPOSE_COMMUNITY_ATTACHMENT];

/** scan_status 语义（禁止伪报）。0 = 未扫描（V1 唯一写入值）。 */
export const SCAN_STATUS = {
  /** NOT_SCANNED：未进行任何恶意代码扫描。 */
  NOT_SCANNED: 0,
  /** CLEAN：真实扫描器通过后才可写入；V1 永不写。 */
  CLEAN: 1,
  /** SUSPECT：保留位。 */
  SUSPECT: 2,
} as const;

/** exif_stripped 语义（禁止伪报）。0 = 未剥离（V1 唯一写入值）。 */
export const EXIF_STATUS = {
  NOT_STRIPPED: 0,
  STRIPPED: 1,
} as const;

/** visibility 取值（files.visibility CHECK 约束一致）。V1 Community 附件恒为 team。 */
export const FILE_VISIBILITY = {
  PUBLIC: 'public',
  TEAM: 'team',
  PRIVATE: 'private',
} as const;

/** object key 前缀（P33-P3A-2 冻结：community/，不是 content/）。 */
export const OBJECT_KEY_PREFIX = 'community';

export type AllowedImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

export interface DetectedImage {
  mime: AllowedImageMime;
  /** 由 magic bytes 推导，只可能是 jpg / png / webp。 */
  ext: 'jpg' | 'png' | 'webp';
}

/**
 * magic bytes 检测（只读前 16 字节）。
 * - JPEG: FF D8 FF
 * - PNG : 89 50 4E 47 0D 0A 1A 0A
 * - WEBP: 'RIFF'(0..3) + 'WEBP'(8..11)
 * 返回 null 表示非允许图片类型（含 gif / heic / heif / svg / 任意伪装内容）。
 */
export function detectImageType(head: Uint8Array): DetectedImage | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (
    head.length >= 8 &&
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47 &&
    head[4] === 0x0d &&
    head[5] === 0x0a &&
    head[6] === 0x1a &&
    head[7] === 0x0a
  ) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (head.length >= 12) {
    const isRiff = head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46;
    const isWebp = head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50;
    if (isRiff && isWebp) return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}

/** 允许列表判定（仅接受已冻结的三种 MIME）。 */
export function isAllowedImageMime(mime: string): mime is AllowedImageMime {
  return (ALLOWED_IMAGE_MIME as readonly string[]).includes(mime);
}

/**
 * original_name sanitize（仅作 metadata）：
 * - 去控制字符、去路径分隔符、去首尾空白；
 * - 截断至 200 字符；
 * - 无法得到安全结果时返回空串（调用方允许空）。
 */
export function sanitizeOriginalName(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[\\/]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 200);
}

/** 取 yyyy / mm（UTC，与 object key 的时间分片一致）。 */
function yyyyMm(now: Date): { yyyy: string; mm: string } {
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return { yyyy, mm };
}

/**
 * 构造 object key（服务端唯一生成入口）：
 *   community/{teamPublicId}/{yyyy}/{mm}/{filePublicId}.{ext}
 * - 不含 numeric team id / numeric user id / 原始文件名 / 任何客户端输入片段；
 * - teamPublicId 与 filePublicId 必须是 ULID（传入前已校验），因此不存在 path traversal。
 */
export function buildObjectKey(input: {
  teamPublicId: string;
  filePublicId: string;
  ext: string;
  now?: Date;
}): string {
  const { yyyy, mm } = yyyyMm(input.now ?? new Date());
  return `${OBJECT_KEY_PREFIX}/${input.teamPublicId}/${yyyy}/${mm}/${input.filePublicId}.${input.ext}`;
}

/** object key 形态校验（实现/测试期自检用；服务端生成的 key 必须匹配）。 */
export function isCommunityObjectKey(key: string): boolean {
  return /^community\/[0-9A-HJKMNP-TV-Z]{26}\/\d{4}\/\d{2}\/[0-9A-HJKMNP-TV-Z]{26}\.(jpg|png|webp)$/.test(
    key,
  );
}
