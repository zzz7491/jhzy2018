// utils/feedbackApi.ts
// P3-E Feedback Domain 统一客户端（用户端：提交意见反馈 / 上传反馈图片）。
//
// 纪律（与 P3-B authApi / P3-C profileApi / P3-D teamApi 完全一致）：
// - 本文件是【用户端 Feedback】域的唯一接入层；页面不得再各自 wx.request / wx.uploadFile /
//   裸读 token / 手拼 URL。
// - 令牌读取一律经 Session Manager（utils/session）；失败一律经 classifyFeedbackError 归一。
// - 所有请求均走 legacy transport（utils/request，jhzyRequest）——原因见下方 Backend Authority。
// - 本阶段【不纳管】pages/admin/feedback-manage/**（Admin 域，用户决策 1=A），
//   因此该页的 legacy 调用本阶段不在本 wrapper 内重复实现。
//
// ============ Backend Authority（P3-E Phase A 审计结论，禁止猜测）============
// 已核对 workers/src/app.ts（27 条 v2.route 挂载清单）+ workers/src/routes/** +
// workers/src/services/** + workers/src/repository/** + workers/migrations/0001_initial_schema.sql：
//
//   【用户端 Feedback 的两个能力】
//   * POST feedback_submit.php        —— Legacy PHP。
//   * POST upload_feedback_image.php  —— Legacy PHP（multipart，字段名 file）。
//
//   【V2 后端现状】
//   * GET / POST / PATCH / DELETE /api/v2/feedback —— 全部 NO V2 IMPLEMENTATION：
//       - workers/src/routes/** 无 feedback 路由文件；app.ts 挂载清单无 /feedback。
//       - workers/src/services + repository 对 feedback / suggestion / complaint 零命中（case-insensitive 全扫）。
//       - workers/migrations/0001 无 feedback 表；唯一命中为 migration_issues.suggestion（迁移审计表，与本域无关）。
//   * workers/src/routes/content.ts 的 POST /articles/:id/report、/comments/:id/report
//     权限为 content.report.create，属于【社区内容举报】，数据模型与意见反馈不同，【不可复用】。
//   * /api/v2/files 仅 purpose=community_attachment，【不能】承载反馈图片。
//
//   ⇒ 结论：本域在 V2 侧为零覆盖；本 wrapper 在统一接入层之下保留 legacy PHP 端点，
//      不伪造 V2 语义、不改写后端、不新建 V2 路由。
//
//   【Admin 侧 Feedback（本阶段明确不纳管，仅记录）】
//   * admin_get_feedbacks.php / admin_update_feedback.php / admin_reply_feedback.php
//     —— 仍由 pages/admin/feedback-manage/index.ts 直连，属 Admin 域，P3-E 授权范围外（用户决策 1=A）。
//     注：admin_reply_feedback.php 由【客户端提交】admin_id / admin_name，存在伪造风险，
//         真值应由服务端派生；本阶段不动，留给后端收口（见 P3-E Remaining Technical Debt）。
//
// ============ 行为保全（P3-E 禁止 UX 回归）============
// - 成功判定沿用 legacy 契约：feedback_submit / upload_feedback_image 均以 code === 200 为成功
//   （与 Admin 侧 code === 0 不同，禁止笼统套用）。
// - 失败文案来源：legacy 返回 message 优先；部分端点为 msg，二者都保留读取。
// - 请求体字段与顺序保持原样：type / content / contact / images / timestamp。
// - 图片 multipart 字段名仍为 file；Authorization 仍由 Session 的 legacy 令牌提供。
//
// - 禁止：Workers / Migration / Database / Permission / RBAC / Content / Files /
//         Profile / Team / Activity / Points / 其它任何域；禁止修改 utils/session.ts。

import { buildHeaders, toApiError, ApiError } from './transport';
import { getLegacyToken } from './session';
import jhzyRequest from './request';

// legacy PHP base（与 utils/request.js 内 baseUrl 同值；uploadFile 无法复用 request.js，故在此显式声明）
const LEGACY_ROOT = 'https://api.jhzyfw.com/api';
const LEGACY_BASE = LEGACY_ROOT + '/';

// ============================== 统一错误分类 ==============================

export type FeedbackErrorKind = 'backend' | 'network' | 'unauthorized' | 'expired' | 'denied';

export interface FeedbackError {
  kind: FeedbackErrorKind;
  /** 可直接展示给用户的中文提示。 */
  message: string;
  /** HTTP 状态码；legacy 端点无 HTTP 状态时为 0。 */
  status: number;
  /** 后端业务码（legacy 为 code，V2 为 error.code —— 本域当前无 V2 路径）。 */
  code: string;
}

function isFeedbackError(e: any): e is FeedbackError {
  return !!e && typeof e === 'object' && typeof e.kind === 'string';
}

/**
 * Feedback 域唯一错误归一入口：Backend / Network / Unauthorized / Session Expired / Permission Denied。
 * 同时接受 transport 的 ApiError、legacy PHP 拒绝形状 {code,msg|message}、wx 原生失败对象与字符串。
 */
export function classifyFeedbackError(e: any): FeedbackError {
  if (isFeedbackError(e)) return e;

  if (typeof e === 'string') {
    return { kind: 'backend', message: e, status: 0, code: '' };
  }

  // transport ApiError（uploadFile 路径由 toApiError 生成）
  if (e && typeof e === 'object' && 'isNetwork' in e) {
    const apiErr = e as ApiError;
    if (apiErr.isNetwork) {
      return { kind: 'network', message: apiErr.message || '网络异常，请重试', status: 0, code: 'NETWORK' };
    }
    if (apiErr.status === 401) {
      return { kind: 'unauthorized', message: apiErr.message || '登录已失效，请重新登录', status: 401, code: apiErr.code };
    }
    if (apiErr.status === 403) {
      return { kind: 'denied', message: apiErr.message || '没有权限执行该操作', status: 403, code: apiErr.code };
    }
    return { kind: 'backend', message: apiErr.message || '请求失败', status: apiErr.status, code: apiErr.code };
  }

  // legacy PHP / wx 原生形状
  const code = e && e.code;
  const msg = e && (e.message || e.msg);
  if (code === 401 || code === -3) {
    return { kind: 'expired', message: msg || '登录已过期，请重新登录', status: 401, code: String(code) };
  }
  if (code === 403) {
    return { kind: 'denied', message: msg || '没有权限执行该操作', status: 403, code: String(code) };
  }
  const errMsg = e && e.errMsg ? String(e.errMsg) : '';
  if (errMsg && /fail|timeout|error/i.test(errMsg)) {
    return { kind: 'network', message: '网络异常，请重试', status: 0, code: 'NETWORK' };
  }
  return { kind: 'backend', message: msg || '请求失败', status: 0, code: code != null ? String(code) : '' };
}

// ============================== ① 提交意见反馈（Legacy：NO V2 IMPLEMENTATION） ==============================

export interface FeedbackSubmitPayload {
  /** 反馈类型：bug / suggestion / experience / other（Legacy 枚举）。 */
  type: string;
  /** 问题描述（≥10 字，校验在页面层）。 */
  content: string;
  /** 联系方式（可选；手机号或邮箱）。 */
  contact: string;
  /** 已上传图片的 URL 列表（由 uploadFeedbackImage 产出）。 */
  images: string[];
  /** 客户端时间戳（Legacy 端点沿用此字段，语义保持不变）。 */
  timestamp: number;
}

interface FeedbackSubmitResponse {
  code: number;
  msg?: string;
  message?: string;
  data?: unknown;
}

/**
 * POST feedback_submit.php —— 提交意见反馈（JSON + Bearer legacy token）。
 *
 * Backend Authority:
 * NO V2 IMPLEMENTATION
 * Keep legacy endpoint until V2 backend exists.
 *
 * 依据：workers/src/app.ts 挂载清单无 /feedback；routes / services / repository /
 * migrations 对 feedback|suggestion|complaint 全零命中。
 * 成功判定遵循本 legacy 端点契约 code === 200（注意：与 Admin 侧 code === 0 不同）。
 */
export async function submitFeedback(payload: FeedbackSubmitPayload): Promise<void> {
  const token = getLegacyToken();
  if (!token) {
    throw classifyFeedbackError({ code: 401, msg: '请先登录' });
  }

  const res = await jhzyRequest<FeedbackSubmitResponse>({
    url: 'feedback_submit.php',
    method: 'POST',
    data: payload,
  });

  if (!res || res.code !== 200) {
    throw classifyFeedbackError(res || { code: -1, msg: '提交失败' });
  }
}

// ============================== ② 上传反馈图片（Legacy：NO V2 IMPLEMENTATION） ==============================

interface FeedbackImageUploadResponse {
  code: number;
  msg?: string;
  message?: string;
  data?: { url?: string };
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
 * POST upload_feedback_image.php（multipart，字段名 file）—— 上传单张反馈图片，返回可直接提交的 URL。
 *
 * Backend Authority:
 * NO V2 IMPLEMENTATION
 * Keep legacy endpoint until V2 backend exists.
 *
 * 依据：/api/v2/files 仅 purpose=community_attachment，无反馈图片端点。
 * 仍走 wx.uploadFile（utils/request.js 不支持 multipart），但 Header 经统一 buildHeaders、
 * 令牌经 Session Manager、错误经 classifyFeedbackError 归一。
 */
export async function uploadFeedbackImage(tempFilePath: string): Promise<string> {
  const token = getLegacyToken();
  if (!token) {
    throw classifyFeedbackError({ code: 401, msg: '请先登录' });
  }

  // contentType:'' → 不设 Content-Type，避免破坏 multipart boundary。
  const header = buildHeaders({ token, contentType: '' });

  const raw: FeedbackImageUploadResponse = await new Promise<FeedbackImageUploadResponse>((resolve, reject) => {
    wx.uploadFile({
      url: LEGACY_BASE + 'upload_feedback_image.php',
      filePath: tempFilePath,
      name: 'file',
      header,
      success: (res: any) => {
        if (res.statusCode === 200) {
          const body = safeParse(res.data);
          if (!body) {
            reject(toApiError(0, null, true, { fallbackMessage: '服务器响应异常' }));
            return;
          }
          resolve(body as FeedbackImageUploadResponse);
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

  if (!raw || raw.code !== 200 || !raw.data || !raw.data.url) {
    throw classifyFeedbackError(raw || { code: -1, msg: '上传失败' });
  }
  return raw.data.url;
}

export default {
  classifyFeedbackError,
  submitFeedback,
  uploadFeedbackImage,
};
