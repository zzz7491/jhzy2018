// utils/quickActionApi.ts
// P3-H Quick Action Domain 统一客户端（随手公益：今日积分 / 记录列表 / 图片上传 / 提交记录）。
//
// 纪律（与 P3-C profileApi / P3-D teamApi / P3-E feedbackApi / P3-F pointsApi / P3-G rankingsApi 完全一致）：
// - 本文件是 Quick Action 域的【唯一】接入层；页面不得再各自 wx.request / wx.uploadFile / 裸读 token / 手拼 URL。
// - 令牌读取一律经 Session Manager（utils/session）；失败一律经 classifyQuickActionError 归一。
// - 所有请求均走 legacy transport（utils/request，jhzyRequest）——原因见下方 Backend Authority。
//
// ============ Backend Authority（P3-H Phase A 审计结论，禁止猜测）============
// 已逐行核对 workers/src/app.ts（27 条 v2.route 挂载全量枚举）+ workers/src/routes/** +
// workers/src/services/** + workers/src/repository/** + workers/migrations/**（42 个文件）+ api-v2/（21 个 .php）：
//
//   * 随手公益四个能力（全部 Legacy PHP）：
//       - GET  quick_actions.php?action=stats    （今日积分）
//       - GET  quick_actions.php?action=list     （记录列表，分页）
//       - POST upload_quick_action.php           （图片上传，multipart，字段名 file）
//       - POST quick_actions.php?action=submit    （提交记录）
//
//   * V2 后端现状：全部 NO V2 IMPLEMENTATION：
//       - workers/src/app.ts 挂载清单无 /quick / quick-action / quickAction；
//       - workers/src/routes/** 无 quick 路由文件；routes/services/repository 对 quick_action 递归大小写不敏感扫描零命中；
//       - 42 个 migration 无 quick_action / 随手公益表；
//       - api-v2/（ThinkPHP 骨架）对 quick_action 扫描 NO HIT —— 亦无 V2 规划。
//
//   ⇒ 结论：本域在 V2 侧为零覆盖；本 wrapper 在统一接入层之下保留 legacy PHP 端点，
//      不伪造 V2 语义、不改写后端、不新建 V2 路由。
//
// ============ 行为保全（P3-H 禁止 UX 回归）============
// - 成功判定沿用 legacy 契约：stats / list / submit 均以 code === 0 为成功；
//   upload 以 code === 0 且 data.full_url 存在为成功（返回 full_url 字符串）。
// - 失败文案来源：legacy 返回 msg 优先（部分端点 message），二者都保留读取；网络失败 reject 经 toApiError。
// - 记录列表：后端记录 map 为页面行（字段名保持原样），hasMore 由 pagination.page < pagination.pages 判定。
// - 图片 multipart 字段名仍为 file；Authorization 仍由 Session 的 legacy 令牌提供。
//
// 禁止修改：Workers / Migration / Database / Permission / RBAC / pages/index/index.ts /
//           pages/admin/** / session.ts / transport.ts / fileApi.ts / 其它任何域。

import { buildHeaders, toApiError, ApiError } from './transport';
import { getLegacyToken } from './session';
import jhzyRequest from './request';

// legacy PHP base（uploadFile 无法复用 request.js，故在此显式声明，与 utils/request.js 内 baseUrl 同值）
const LEGACY_ROOT = 'https://api.jhzyfw.com/api';
const LEGACY_BASE = LEGACY_ROOT + '/';

// ============================== 统一错误分类 ==============================

export type QuickActionErrorKind = 'backend' | 'network' | 'unauthorized' | 'expired' | 'denied';

export interface QuickActionError {
  kind: QuickActionErrorKind;
  /** 可直接展示给用户的中文提示。 */
  message: string;
  /** HTTP 状态码；legacy 端点无 HTTP 状态时为 0。 */
  status: number;
  /** 后端业务码（legacy 为 code）。 */
  code: string;
}

function isQuickActionError(e: any): e is QuickActionError {
  return !!e && typeof e === 'object' && typeof e.kind === 'string';
}

/**
 * Quick Action 域唯一错误归一入口：Backend / Network / Unauthorized / Session Expired / Permission Denied。
 * 同时接受 transport 的 ApiError、legacy PHP 拒绝形状 {code,msg|message}、wx 原生失败对象与字符串。
 */
export function classifyQuickActionError(e: any): QuickActionError {
  if (isQuickActionError(e)) return e;

  if (typeof e === 'string') {
    return { kind: 'backend', message: e, status: 0, code: '' };
  }

  // transport ApiError（uploadFile 路径由 toApiError 生成）
  if (e && typeof e === 'object' && 'isNetwork' in e) {
    const apiErr = e as ApiError;
    if (apiErr.isNetwork) {
      return { kind: 'network', message: apiErr.message || '网络异常，请检查网络连接', status: 0, code: 'NETWORK' };
    }
    if (apiErr.status === 401) {
      return { kind: 'unauthorized', message: apiErr.message || '登录已失效，请重新登录', status: 401, code: apiErr.code };
    }
    if (apiErr.status === 403) {
      return { kind: 'denied', message: apiErr.message || '无权限执行该操作', status: 403, code: apiErr.code };
    }
    return { kind: 'backend', message: apiErr.message || '请求失败，请稍后重试', status: apiErr.status, code: apiErr.code };
  }

  // legacy PHP / wx 原生形状
  const code = e && e.code;
  const msg = e && (e.msg || e.message);
  if (code === 401 || code === -3) {
    return { kind: 'expired', message: msg || '登录已过期，请重新登录', status: 401, code: String(code) };
  }
  if (code === 403) {
    return { kind: 'denied', message: msg || '无权限执行该操作', status: 403, code: String(code) };
  }
  const errMsg = e && e.errMsg ? String(e.errMsg) : '';
  if (errMsg && /fail|timeout|error/i.test(errMsg)) {
    return { kind: 'network', message: '网络异常，请检查网络连接', status: 0, code: 'NETWORK' };
  }
  return { kind: 'backend', message: msg || '请求失败，请稍后重试', status: 0, code: code != null ? String(code) : '' };
}

// ============================== ① 今日积分（Legacy：NO V2 IMPLEMENTATION） ==============================

export interface QuickStats {
  todayPoints: number;
  maxPointsPerDay: number;
}

interface QuickStatsResponse {
  code: number;
  msg?: string;
  message?: string;
  data?: {
    today_points?: number;
    max_daily_points?: number;
  };
}

/**
 * GET quick_actions.php?action=stats —— 今日公益积分与每日上限。
 *
 * Backend Authority:
 * NO V2 IMPLEMENTATION
 * Keep legacy endpoint until V2 backend exists.
 *
 * 依据：workers/src/app.ts 挂载清单无 quick；routes/services/repository 对 quick_action 零命中；
 * 42 个 migration 无随手公益表；api-v2 骨架亦无规划。
 * 成功契约沿用原页面判定：code === 0；非 0 ⇒ 抛出 classifyQuickActionError（页面以 toast 展示 msg）。
 */
export async function getQuickStats(): Promise<QuickStats> {
  const token = getLegacyToken();
  if (!token) {
    throw classifyQuickActionError({ code: 401, msg: '请先登录' });
  }

  const res = await jhzyRequest<QuickStatsResponse>({
    url: 'quick_actions.php?action=stats',
    method: 'GET',
  });

  if (!res || res.code !== 0) {
    throw classifyQuickActionError(res || { code: -1, msg: '获取积分失败' });
  }

  const data = res.data || {};
  return {
    todayPoints: data.today_points || 0,
    maxPointsPerDay: data.max_daily_points || 5,
  };
}

// ============================== ② 记录列表（Legacy：NO V2 IMPLEMENTATION） ==============================

export interface QuickActionRecord {
  id: number | string;
  action_name: string;
  description: string;
  create_time: string;
  points: number;
  status: string;
  status_text: string;
  type: string;
  location: string;
  images: string;
}

export interface QuickActionListResult {
  records: QuickActionRecord[];
  hasMore: boolean;
}

interface QuickActionListResponse {
  code: number;
  msg?: string;
  message?: string;
  data?: {
    records?: any[];
    pagination?: { page?: number; pages?: number; [key: string]: unknown };
  };
}

/** 原页面逐字保留的字段映射（status 数字 → 展示文本）。 */
function mapQuickRecord(record: any): QuickActionRecord {
  return {
    id: record.id,
    action_name: record.title || record.type || '公益行为',
    description: record.description || '',
    create_time: record.created_at,
    points: record.points || 1,
    status: record.status == 1 ? 'approved' : record.status == 0 ? 'pending' : 'rejected',
    status_text: record.status === 1 ? '已通过' : record.status === 0 ? '审核中' : '已拒绝',
    type: record.type,
    location: record.location || '未记录位置',
    images: record.images || '',
  };
}

/**
 * GET quick_actions.php?action=list&page=&limit= —— 随手公益记录（分页）。
 *
 * Backend Authority:
 * NO V2 IMPLEMENTATION
 * Keep legacy endpoint until V2 backend exists.
 *
 * 依据同上。hasMore 判定沿用原实现：pagination.page < pagination.pages。
 */
export async function listQuickActions(page: number, limit: number): Promise<QuickActionListResult> {
  const token = getLegacyToken();
  if (!token) {
    throw classifyQuickActionError({ code: 401, msg: '请先登录' });
  }

  const res = await jhzyRequest<QuickActionListResponse>({
    url: `quick_actions.php?action=list&page=${page}&limit=${limit}`,
    method: 'GET',
  });

  if (!res || res.code !== 0) {
    throw classifyQuickActionError(res || { code: -1, msg: '获取记录失败' });
  }

  const data = res.data || {};
  const records = (data.records || []).map(mapQuickRecord);
  const pagination = data.pagination || {};
  const hasMore = (pagination.page || 0) < (pagination.pages || 0);

  return { records, hasMore };
}

// ============================== ③ 图片上传（Legacy：NO V2 IMPLEMENTATION） ==============================

interface QuickActionUploadResponse {
  code: number;
  msg?: string;
  message?: string;
  data?: { full_url?: string };
}

function safeParse(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

/**
 * POST upload_quick_action.php（multipart，字段名 file）—— 上传单张公益凭证，返回完整 URL。
 *
 * Backend Authority:
 * NO V2 IMPLEMENTATION
 * Keep legacy endpoint until V2 backend exists.
 *
 * fileApi 拒绝承载 legacy 上传端点（仅服务 /api/v2/files），故本能力保留在 quickActionApi。
 * 仍走 wx.uploadFile（utils/request.js 不支持 multipart），但 Header 经统一 buildHeaders、
 * 令牌经 Session Manager、错误经 classifyQuickActionError 归一。
 */
export async function uploadQuickActionImage(tempFilePath: string): Promise<string> {
  const token = getLegacyToken();
  if (!token) {
    throw classifyQuickActionError({ code: 401, msg: '请先登录' });
  }

  // contentType:'' → 不设 Content-Type，避免破坏 multipart boundary；formData.type 保持原样。
  const header = buildHeaders({ token, contentType: '' });

  const raw: QuickActionUploadResponse = await new Promise<QuickActionUploadResponse>((resolve, reject) => {
    wx.uploadFile({
      url: LEGACY_BASE + 'upload_quick_action.php',
      filePath: tempFilePath,
      name: 'file',
      formData: { type: 'quick_action' },
      header,
      success: (res: any) => {
        if (res.statusCode === 200) {
          const body = safeParse(res.data);
          if (!body) {
            reject(toApiError(0, null, true, { fallbackMessage: '服务器响应异常' }));
            return;
          }
          resolve(body as QuickActionUploadResponse);
        } else {
          reject(
            toApiError(res.statusCode, safeParse(res.data), false, {
              fallbackMessage: `上传失败，状态码: ${res.statusCode}`,
            }),
          );
        }
      },
      fail: () => {
        reject(toApiError(0, null, true, { fallbackMessage: '网络请求失败' }));
      },
    });
  });

  if (!raw || raw.code !== 0 || !raw.data || !raw.data.full_url) {
    throw classifyQuickActionError(raw || { code: -1, msg: '上传失败' });
  }
  return raw.data.full_url;
}

// ============================== ④ 提交记录（Legacy：NO V2 IMPLEMENTATION） ==============================

export interface QuickActionSubmitPayload {
  /** 行动类型（与 actions 列表 type 一致）。 */
  type: string;
  /** 行动名称（currentAction.name）。 */
  title: string;
  /** 描述（≥10 字，校验在页面层）。 */
  description: string;
  /** 已上传图片的完整 URL（由 uploadQuickActionImage 产出）。 */
  images: string;
  /** 位置信息字符串（优先 address，其次 locationName / 经纬度 / 手动输入）。 */
  location: string;
  /** 该行动分值（currentAction.points）。 */
  points: number;
}

interface QuickActionSubmitResponse {
  code: number;
  msg?: string;
  message?: string;
  data?: unknown;
}

/**
 * POST quick_actions.php?action=submit —— 提交一条随手公益记录。
 *
 * Backend Authority:
 * NO V2 IMPLEMENTATION
 * Keep legacy endpoint until V2 backend exists.
 *
 * 依据同上。成功契约 code === 0；非 0（含 code 400 / message 含「已达上限」）由调用方读取 message 展示。
 */
export async function submitQuickAction(payload: QuickActionSubmitPayload): Promise<void> {
  const token = getLegacyToken();
  if (!token) {
    throw classifyQuickActionError({ code: 401, msg: '请先登录' });
  }

  const res = await jhzyRequest<QuickActionSubmitResponse>({
    url: 'quick_actions.php?action=submit',
    method: 'POST',
    data: payload,
  });

  if (!res || res.code !== 0) {
    throw classifyQuickActionError(res || { code: -1, msg: '提交失败，请重试' });
  }
}

export default {
  classifyQuickActionError,
  getQuickStats,
  listQuickActions,
  uploadQuickActionImage,
  submitQuickAction,
};
