// utils/rankingsApi.ts
// P3-G Rankings Domain 统一客户端（志愿者积分排行榜）。
//
// 纪律（与 P3-C profileApi / P3-D teamApi / P3-E feedbackApi / P3-F pointsApi 完全一致）：
// - 本文件是【唯一】Rankings 接入层；页面不得再各自 wx.request / 硬编码 API host / 拼装 query。
// - 请求核心经 transport.buildHeaders（唯一 Header Builder）与 transport.toApiError（唯一 Error Pipeline）；
//   失败一律经 classifyRankingsError 归一为五类。
// - 禁止触碰其它业务域 wrapper。
//
// ============ Backend Authority（P3-G Phase A 审计结论，禁止猜测）============
// 已逐行核对 workers/src/app.ts（27 条 v2.route 挂载全量枚举）+ workers/src/routes/** +
// workers/src/services/** + workers/src/repository/** + workers/migrations/**（42 个文件）：
//
//   * GET /api/v2/rankings（含 rank / leaderboard / board 任何变体）—— NO V2 IMPLEMENTATION：
//       - app.ts 挂载清单：system / users / teams / activities / attendance-sessions /
//         attendance-anomalies / service-records / service-record-adjustments / points / mall /
//         forms / training / exams / certificates / files / content / ai / admin/content /
//         analytics / admin/delivery-diagnostics / volunteer / users/me/phone /
//         users/me/qualification / notifications / subscriptions / auth / __test —— 无 rankings。
//       - routes/services/repository 对 rank|leaderboard 递归大小写不敏感扫描零命中
//         （唯一命中是 participation 模块的 P19 onboarding 注释，含 board 子串，非排行榜）。
//       - 42 个 migration 无 rank / leaderboard / 排行表。
//   * 【唯一近似物不可复用】GET /api/v2/analytics/team/overview 与 /platform/overview：
//       - routes/analytics.ts 头部明确契约：仅返回 scope / range / period / metrics（11 个聚合数字），
//         不返回 raw rows / PII / numeric id —— 无「一人一行」，无法渲染排行榜。
//       - 且需 analytics.team.view / analytics.platform.view 权限，游客不可达（见下条）。
//   * api-v2/（ThinkPHP 6 骨架，21 个 .php）对 ranking|leaderboard|rank 递归扫描 NO HIT —— 亦无 V2 规划。
//
//   ⇒ 结论：Rankings 域在 V2 侧为零覆盖；本 wrapper 在统一接入层之下保留 legacy PHP 端点，
//      不伪造 V2 语义、不改写后端、不新建 V2 路由。
//
// ============ 公开端点语义（P3-G 最重要约束，禁止污染）============
// - legacy rankings.php 是【公开端点】：迁移前该请求不带任何 Authorization 头、不带 token，
//   与 guest 浏览契约一致（排行榜必须游客可见）。
// - 因此本 wrapper 【刻意不走】utils/request（jhzyRequest）：
//     request.js 会注入 Bearer<legacy token>，且其令牌过期闸门（isLegacyTokenExpired）
//     会触发 session.clearSession() + redirectTo 登录页 —— 对游客而言会把公开榜单变成
//     「强制登录」，属行为回归。
// - buildHeaders() 不传 token / 不传 teamScoped ⇒ 不生成 Authorization / X-Team-Id 头。
// - Contract 会断言本文件不得出现 getLegacyToken / getV2Token / Authorization / session 引用。
//
// ============ 行为保全（P3-G 禁止 UX 回归）============
// - 成功判定沿用 legacy 契约：code === 0；非 0 或 data 非数组 ⇒ 空列表（静默，不弹错）。
// - 网络失败才会 reject；HTTP 非 2xx 仍走 wx success 回调，与原实现一致（不会抛错）。
// - hasMore 判定：返回条数 === 本次请求的 limit（满载才认为还有下一页）——页面侧语义，逐字保留。
// - 头像 avatar 字段：P3-G 决策 2=A —— 【不做】normalizeAvatarUrl，直传 legacy 返回值，
//   不改变任何显示行为。
//
// 禁止修改：Workers / Migration / Database / Permission / RBAC / session.ts / transport.ts /
//          pages/index/index.ts / pointsApi / profileApi / teamApi / feedbackApi /
//          activityApi / mallApi / 其它任何域。

import { buildHeaders, toApiError } from './transport';

// legacy PHP base（与 utils/request.js 内 baseUrl 同值）。
// 注意：本域【不走】request.js（避免令牌污染公开端点），故在此显式声明同样的 root。
const LEGACY_BASE = 'https://api.jhzyfw.com/api/';

// ============================== 统一错误分类 ==============================

export type RankingsErrorKind = 'backend' | 'network' | 'unauthorized' | 'expired' | 'denied';

export interface RankingsError {
  kind: RankingsErrorKind;
  /** 可直接展示给用户的中文提示。 */
  message: string;
  /** HTTP 状态码；网络失败为 0。 */
  status: number;
  /** 后端业务码（legacy 为 code）。 */
  code: string;
}

function isRankingsError(e: any): e is RankingsError {
  return !!e && typeof e === 'object' && typeof e.kind === 'string';
}

/**
 * Rankings 域唯一错误归一入口：Backend / Network / Unauthorized / Session Expired / Permission Denied。
 * 接受 transport 的 ApiError、legacy PHP 拒绝形状 {code,msg}、wx 原生失败对象与字符串。
 */
export function classifyRankingsError(e: any): RankingsError {
  if (isRankingsError(e)) return e;

  if (typeof e === 'string') {
    return { kind: 'backend', message: e, status: 0, code: '' };
  }

  // transport ApiError（本域仅在 wx.request fail 时由 toApiError 生成）
  if (e && typeof e === 'object' && 'isNetwork' in e) {
    const apiErr = e as { status: number; code: string; message: string; isNetwork: boolean };
    if (apiErr.isNetwork) {
      return { kind: 'network', message: apiErr.message || '网络异常，请检查网络连接', status: 0, code: 'NETWORK' };
    }
    if (apiErr.status === 401) {
      return { kind: 'unauthorized', message: apiErr.message || '登录已失效，请重新登录', status: 401, code: apiErr.code };
    }
    if (apiErr.status === 403) {
      return { kind: 'denied', message: apiErr.message || '无权限查看排行榜', status: 403, code: apiErr.code };
    }
    return { kind: 'backend', message: apiErr.message || '加载失败，请稍后重试', status: apiErr.status, code: apiErr.code };
  }

  // legacy PHP / wx 原生形状
  const code = e && e.code;
  const msg = e && (e.msg || e.message);
  if (code === 401 || code === -3) {
    return { kind: 'expired', message: msg || '登录已失效，请重新登录', status: 401, code: String(code) };
  }
  if (code === 403) {
    return { kind: 'denied', message: msg || '无权限查看排行榜', status: 403, code: String(code) };
  }
  const errMsg = e && e.errMsg ? String(e.errMsg) : '';
  if (errMsg && /fail|timeout|error/i.test(errMsg)) {
    return { kind: 'network', message: '网络异常，请检查网络连接', status: 0, code: 'NETWORK' };
  }
  return { kind: 'backend', message: msg || '加载失败，请稍后重试', status: 0, code: code != null ? String(code) : '' };
}

// ============================== 排行榜数据契约 ==============================

/**
 * 排行榜行（Legacy 返回，字段名保持原样）。
 * 字段来源：rankings.wxml 绑定 + rankings.ts 详情弹窗消费点反推。
 *
 * P3-G 决策 2=A：avatar 【保持现状】，不做 normalizeAvatarUrl、不做任何 URL 归一，
 * 直传 legacy 返回值（页面 {{item.avatar}} 直绑），不改变任何显示行为。
 */
export interface RankingRow {
  user_id?: string | number;
  volunteer_id?: string;
  real_name?: string;
  avatar?: string;
  total_points?: number;
  total_hours?: number;
  /** legacy 可能返回其它字段，透传给页面（页面只消费上述已知字段）。 */
  [key: string]: unknown;
}

export interface RankingPageParams {
  /** 页码，从 1 开始。 */
  page: number;
  /** 每页条数。页面现行值为 20。 */
  limit: number;
}

export interface RankingPageResult {
  /**
   * 本次请求取到的行。
   * code !== 0 或 data 非数组 ⇒ 空数组（与原实现「静默空列表，不弹错」一致）。
   */
  rows: RankingRow[];
  /** legacy 业务码；网络失败不会走到这里。 */
  code: number;
}

interface RankingsResponse {
  code?: number;
  msg?: string;
  data?: unknown;
}

/**
 * GET rankings.php —— 志愿者积分排行榜（分页）。
 *
 * Backend Authority:
 * NO V2 IMPLEMENTATION
 * Keep legacy endpoint until V2 backend exists.
 *
 * 依据：workers/src/app.ts 挂载清单无 /rankings；routes / services / repository 对
 * rank|leaderboard 零命中；42 个 migration 无排行榜表；analytics/overview 仅返回聚合数字且需权限。
 *
 * 公开端点：不注入任何令牌（见文件头「公开端点语义」），保持游客可见。
 * 成功契约沿用原页面判定：res.data.code === 0 且 Array.isArray(res.data.data)。
 * 仅【网络失败】才 reject（HTTP 非 2xx 仍按原实现走 success 路径，不抛错）。
 */
export function listRankings(params: RankingPageParams): Promise<RankingPageResult> {
  // token / teamScoped 一律不传 ⇒ 不生成 Authorization / X-Team-Id；
  // Content-Type: application/json 与 wx.request 默认头一致，属等价行为。
  const header = buildHeaders();

  return new Promise<RankingPageResult>((resolve, reject) => {
    wx.request({
      url: `${LEGACY_BASE}rankings.php`,
      method: 'GET',
      data: { page: params.page, limit: params.limit },
      header,
      success: (res: any) => {
        const body = (res && res.data ? res.data : null) as RankingsResponse | null;
        const rows = body && body.code === 0 && Array.isArray(body.data) ? (body.data as RankingRow[]) : [];
        resolve({ rows, code: body && typeof body.code === 'number' ? body.code : -1 });
      },
      fail: () => {
        reject(toApiError(0, null, true, { fallbackMessage: '网络请求失败' }));
      },
    });
  });
}

export default {
  classifyRankingsError,
  listRankings,
};
