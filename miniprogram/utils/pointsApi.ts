// utils/pointsApi.ts
// P3-F Points Domain 统一客户端（积分概况 / 志愿者等级 / 积分流水）。
//
// 纪律（与 P3-C profileApi / P3-D teamApi / P3-E feedbackApi 同范式）：
// - 本文件是【唯一】Points 接入层；页面不得再各自 wx.request / wx.getStorageSync('userInfo'|'access_token')
//   / 自行拼装 baseUrl（wx.$baseUrl）。
// - 会话读取一律经 Session Manager（utils/session）；错误一律经 classifyPointsError 归一为五类。
// - V2 能力走 transport.send；Legacy 能力走 utils/request（jhzyRequest）——理由见下方 Backend Authority。
//
// ============ Backend Authority（P3-F Phase A 审计结论，禁止猜测）============
// 已逐行核对 workers/src/app.ts（27 条 v2.route 挂载）+ routes/points.ts +
// services/points-service.ts + migrations/0018_points_ledger.sql + 全仓 migrations/**：
//   * GET /api/v2/points/account        ✅ 已有（SELF，requirePermission('points.account.read')）
//       —— 返回 balance_units / total_earned_units / total_spent_units / total_debits_units / updated_at。
//   * GET /api/v2/points/transactions   ✅ 已有（SELF，分页 page/page_size，max=100，剔除内部 numeric id）。
//   * GET /points、GET /points/history  ❌ NO V2 IMPLEMENTATION（等价能力为 /points/transactions）。
//   * POST /points/exchange             ❌ NO V2 IMPLEMENTATION（兑换实际由 POST /api/v2/mall/orders 承载，属 Mall 域）。
//   * GET /rewards、POST /rewards/exchange ❌ NO V2 IMPLEMENTATION
//       （workers/src 全仓 reward 大小写不敏感递归扫描零命中；42 个 migration 无 rewards / points_exchange 表）。
//   * 志愿者等级 level / next_level_points / progress ❌ NO V2 等价能力
//       —— V2 仅有 users.cert_level（0/1/2 认证等级），与「按累计积分晋升志愿者等级」语义不同。
// => 结论：本页的【等级 / 晋升进度】唯一数据来源仍是 legacy user_info.php（P3-F 决策 2=A：保留等级显示），
//    该函数在统一 wrapper 之下保留 legacy PHP 端点并显式标注 NO V2 IMPLEMENTATION，不伪造 V2 语义。
//
// ============ 数值口径（P3-F 决策 3=A：本阶段禁止换算）============
// - migrations/0018_points_ledger.sql 定义 POINTS_UNITS_PER_POINT = 100（100 units = 1.00 point）。
// - 本 wrapper 【不做】units↔points 换算，也不实现任何数值 formatter：
//   展示 formatter 的唯一实现仍在 utils/mallApi 的 formatPoints（历史位置，本阶段禁止修改），
//   formatUnits() 仅做透传，避免产生第二份口径实现。
// - 由此产生的「同屏两套数值体系」（legacy current_points 的 points 口径 vs V2 amount_units 的 units 口径）
//   已登记为 P3-F Technical Debt，需专门阶段收口；本阶段禁止改动展示。
//
// 禁止触碰：Workers / Migration / Database / Permission / RBAC / Mall / Activity / Quick-Action
//          / Profile / Admin / session.ts。

import { send, ApiError } from './transport';
import { resolveV2Base } from './apiEnv';
import { getLegacyToken, getUserInfo } from './session';
import jhzyRequest from './request';
import { formatPoints } from './mallApi';

const V2_BASE = resolveV2Base();

// ============================== 统一错误分类 ==============================

export type PointsErrorKind = 'backend' | 'network' | 'unauthorized' | 'expired' | 'denied';

export interface PointsError {
  kind: PointsErrorKind;
  /** 可直接展示给用户的中文提示。 */
  message: string;
  /** HTTP 状态码；legacy 端点无 HTTP 状态时为 0。 */
  status: number;
  /** 后端业务码（legacy 为 code，V2 为 error.code）。 */
  code: string;
}

function isPointsError(e: any): e is PointsError {
  return !!e && typeof e === 'object' && typeof e.kind === 'string';
}

/**
 * Points 域唯一错误归一入口：Backend / Network / Unauthorized / Session Expired / Permission Denied。
 * 同时接受 transport 的 ApiError、legacy PHP 拒绝形状 {code,msg}、wx 原生失败对象与字符串。
 */
export function classifyPointsError(e: any): PointsError {
  if (isPointsError(e)) return e;

  if (typeof e === 'string') {
    return { kind: 'backend', message: e, status: 0, code: '' };
  }

  // transport ApiError（V2 路径）
  if (e && typeof e === 'object' && 'isNetwork' in e) {
    const apiErr = e as ApiError;
    if (apiErr.isNetwork) {
      return { kind: 'network', message: apiErr.message || '网络异常，请检查网络连接', status: 0, code: 'NETWORK' };
    }
    if (apiErr.status === 401) {
      return { kind: 'unauthorized', message: apiErr.message || '登录已失效，请重新登录', status: 401, code: apiErr.code };
    }
    if (apiErr.status === 403) {
      return { kind: 'denied', message: apiErr.message || '无权限查看积分记录', status: 403, code: apiErr.code };
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
    return { kind: 'denied', message: msg || '无权限查看积分记录', status: 403, code: String(code) };
  }
  const errMsg = e && e.errMsg ? String(e.errMsg) : '';
  if (errMsg && /fail|timeout|error/i.test(errMsg)) {
    return { kind: 'network', message: '网络异常，请检查网络连接', status: 0, code: 'NETWORK' };
  }
  return { kind: 'backend', message: msg || '加载失败，请稍后重试', status: 0, code: code != null ? String(code) : '' };
}

// ============================== 登录态快照 ==============================

export interface PointsLoginSnapshot {
  isLoggedIn: boolean;
  userInfo: any;
  token: string;
}

/**
 * 读取登录态快照（Points 页面唯一入口）。
 * 令牌 / userInfo 一律经 Session Manager 读取，页面不得 wx.getStorageSync('userInfo' | 'access_token')。
 * 判定语义保持原样：userInfo && token 同时存在才算已登录（不使用 isLoggedIn 布尔标志）。
 */
export function readLoginSnapshot(): PointsLoginSnapshot {
  const userInfo = getUserInfo();
  const token = getLegacyToken();
  return { isLoggedIn: !!(userInfo && token), userInfo, token };
}

// ============================== 积分概况 + 志愿者等级（legacy：NO V2 等价能力） ==============================

export interface LegacyPointsView {
  current_points: number;
  total_points: number;
  /** 志愿者等级名称；V2 无等价字段（cert_level 为认证等级，语义不同）。 */
  level: string;
  next_level_points: number;
  progress: number;
}

export interface PointsSummaryResult {
  points: LegacyPointsView;
  /** 可安全写回 userInfo 的合并对象（cached userInfo + 响应，均已剔除 openid）。 */
  safeUserInfo: Record<string, unknown>;
}

/** 移除 openid（P0-3 S2B 安全约束集中在此处执行，避免页面各自散写）。 */
function omitOpenid(source: any): Record<string, unknown> {
  if (!source || typeof source !== 'object') return {};
  const { openid, ...rest } = source as Record<string, any>;
  void openid;
  return rest;
}

function toNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toStringValue(value: unknown, fallback: string): string {
  return value === undefined || value === null || value === '' ? fallback : String(value);
}

/**
 * GET user_info.php —— 积分概况（当前积分 / 累计积分）与【志愿者等级 / 晋升进度】。
 *
 * Backend Authority:
 * NO V2 IMPLEMENTATION
 * Keep legacy endpoint until V2 backend exists.
 *
 * 说明：V2 只有 points.account（balance/total units）与 users.cert_level（认证等级），
 * 不提供 level / next_level_points / progress；P3-F 决策 2=A —— 保留本端点、保留等级显示、
 * 不修改任何业务行为。
 * 成功契约沿用原页面判定：code === 0 或 code === 200。
 */
export async function getPointsSummary(): Promise<PointsSummaryResult> {
  const res: any = await jhzyRequest({ url: 'user_info.php', method: 'GET' });
  if (!res || (res.code !== 0 && res.code !== 200)) {
    throw classifyPointsError(res || { code: -1, msg: '加载积分失败' });
  }

  const userData = (res && res.data) || {};
  // P0-3 S2B：两个输入源（本地缓存 + 响应）都剔除 openid；合并优先级保持原样（响应覆盖缓存）。
  const safeCached = omitOpenid(getUserInfo());
  const safeUserData = omitOpenid(userData);
  const safeUserInfo: Record<string, unknown> = { ...safeCached, ...safeUserData };

  return {
    points: {
      current_points: toNumber(safeUserData.current_points, 0),
      total_points: toNumber(safeUserData.total_points, 0),
      level: toStringValue(safeUserData.level, '初级志愿者'),
      next_level_points: toNumber(safeUserData.next_level_points, 100),
      progress: toNumber(safeUserData.progress, 0),
    },
    safeUserInfo,
  };
}

// ============================== 积分流水（V2：已实现） ==============================

export interface PointsTransactionView {
  direction: number;
  amount_units: number;
  balance_after_units: number;
  type: string;
  source_type: string | null;
  source_public_id: string | null;
  remark: string | null;
  created_at: number;
}

export interface PointsTransactionPage {
  items: PointsTransactionView[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
}

/**
 * GET /api/v2/points/transactions —— 当前登录用户自己的积分流水（SELF，分页）。
 *
 * Backend Authority（已实现）：
 * workers/src/routes/points.ts:27 —— requirePermission('points.account.read')，
 * 上界由后端控制（page_size max=100），响应已剔除内部 numeric id。
 *
 * 令牌 / 团队作用域：本阶段【保持迁移前原样】（legacy 令牌 + teamScoped:true），
 * 切换令牌家族会改变运行时行为（属未授权变更），故不在 P3-F 处理；
 * 已知由此产生的 401 风险已登记为 Technical Debt #1。
 */
export function getPointsTransactions(page = 1, pageSize = 20): Promise<PointsTransactionPage> {
  return send<PointsTransactionPage>(
    'GET',
    `${V2_BASE}/points/transactions?page=${page}&page_size=${pageSize}`,
    undefined,
    { token: getLegacyToken(), teamScoped: true },
  );
}

// ============================== 数值展示（透传，禁止换算） ==============================

/**
 * 积分展示（P3-F 决策 3=A）：透传至 utils/mallApi 的 formatPoints —— 唯一口径实现。
 * 本文件禁止实现第二份 formatter，禁止任何 units↔points 乘除换算。
 */
export function formatUnits(units?: number | null): string {
  return formatPoints(units);
}

export default {
  classifyPointsError,
  readLoginSnapshot,
  getPointsSummary,
  getPointsTransactions,
  formatUnits,
};
