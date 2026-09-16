// utils/profileApi.ts
// P3-C Profile Domain 统一客户端（个人资料 / 修改密码 / 头像）。
//
// 纪律（与 P3-B authApi 一致）：
// - 本文件是【唯一】Profile 接入层；页面不得再各自 wx.request / wx.uploadFile / jhzyRequest。
// - 会话读写一律经 Session Manager（utils/session）；错误一律经 classifyProfileError 归一。
// - V2 能力走 transport.send；Legacy 能力走 utils/request（jhzyRequest）——原因见下方 Backend Authority 注释。
//
// ============ Backend Authority（P3-C Phase A 审计结论，禁止猜测）============
// 已核对 workers/src/app.ts + workers/src/routes/* + workers/migrations/0001_initial_schema.sql：
//   * /api/v2/users 仅挂载 GET /me（workers/src/routes/users.ts），返回
//     users(id, public_id, nickname, cert_level, status, created_at)
//     + user_profiles(user_id, gender, birthday, region_code, bio)。
//   * 不存��� PATCH/PUT /users/me（无更新资料端点）。
//   * 全仓 workers/src 无 password / avatar 路由实现（已 grep 确认）。
//   * /api/v2/files 仅 purpose=community_attachment（ Community 图片），无头像绑定端点。
//   * user_profiles 表无 phone / email / emergency_contact / emergency_phone / address / avatar。
// => 结论：Profile 的【更新资料 / 修改密码 / 上传头像】在 V2 均为 NO V2 IMPLEMENTATION，
//    本 wrapper 在统一接入层之下保留对应 legacy PHP 端点（与 P3-B authApi 的 legacy 凭证登录同一范式），
//    不伪造 V2 语义、不改写后端。V2 已具备的 users/me 投影以 getV2Profile() 暴露。
// - 禁止：Workers / Migration / Database / Permission / RBAC / 其它域。

import { send, buildHeaders, toApiError, ApiError } from './transport';
import { resolveV2Base } from './apiEnv';
import { getV2Token, getLegacyToken } from './session';
import jhzyRequest from './request';

const V2_BASE = resolveV2Base();
// legacy PHP base（与 utils/request.js 内 baseUrl 同值；uploadFile 无法复用 request.js，故在此显式声明）
const LEGACY_ROOT = 'https://api.jhzyfw.com/api';
const LEGACY_BASE = LEGACY_ROOT + '/';

// ============================== 统一错误分类 ==============================

export type ProfileErrorKind = 'backend' | 'network' | 'unauthorized' | 'expired' | 'denied';

export interface ProfileError {
  kind: ProfileErrorKind;
  /** 可直接展示给用户的中文提示。 */
  message: string;
  /** HTTP 状态码；legacy 端点无 HTTP 状态时为 0。 */
  status: number;
  /** 后端业务码（legacy 为 code，V2 为 error.code）。 */
  code: string;
}

function isProfileError(e: any): e is ProfileError {
  return !!e && typeof e === 'object' && typeof e.kind === 'string';
}

/**
 * Profile 域唯一错误归一入口：Backend / Network / Unauthorized / Session Expired / Permission Denied。
 * 同时接受 transport 的 ApiError、legacy PHP 拒绝形状 {code,msg}、wx 原生失败对象与字符串。
 */
export function classifyProfileError(e: any): ProfileError {
  if (isProfileError(e)) return e;

  if (typeof e === 'string') {
    return { kind: 'backend', message: e, status: 0, code: '' };
  }

  // transport ApiError（V2 路径 / uploadFile 路径）
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
  const msg = e && (e.msg || e.message);
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

// ============================== 头像 URL 归一 ==============================

/** legacy PHP 返回的相对头像路径 → 绝对 URL（与既有页面修正逻辑等价，集中于此避免散写）。 */
export function normalizeAvatarUrl(avatar: string): string {
  if (!avatar) return '';
  if (avatar.startsWith('http') || avatar.startsWith('/images')) return avatar;
  if (avatar.startsWith('/')) return LEGACY_ROOT + avatar;
  return LEGACY_BASE + avatar;
}

// ============================== 读取资料（legacy：NO V2 等价能力） ==============================

export interface UserProfileView {
  volunteer_id?: string;
  real_name?: string;
  id_card?: string;
  register_date?: string;
  phone?: string;
  email?: string;
  emergency_contact?: string;
  emergency_phone?: string;
  gender?: string | number;
  birthday?: string | null;
  address?: string;
  avatar?: string;
  signature?: string;
  modify_history?: unknown[];
}

/**
 * GET user_profile.php —— 当前用户完整资料。
 * NO V2 IMPLEMENTATION：V2 /api/v2/users/me 不返回 phone/email/紧急联系人/address/avatar/签名/志愿者号，
 * 字段集不足以服务 Profile 页面，故保留 legacy 端点（统一经本 wrapper）。
 */
export async function getProfile(): Promise<UserProfileView> {
  const res: any = await jhzyRequest({ url: 'user_profile.php', method: 'GET' });
  if (!res || res.code !== 0 || !res.data) {
    throw classifyProfileError(res || { code: -1, msg: '加载失败' });
  }
  return res.data as UserProfileView;
}

// ============================== 更新资料（legacy：NO V2 IMPLEMENTATION） ==============================

export interface ProfileUpdatePayload {
  phone: string;
  emergency_contact?: string;
  emergency_phone?: string;
  gender?: string;
  birthday?: string | null;
  address?: string;
}

/**
 * POST update_profile.php —— 更新可修改字段（phone / emergency_* / gender / birthday / address）。
 * NO V2 IMPLEMENTATION：workers/src/routes/users.ts 仅有 GET /me，无 PATCH/PUT。
 */
export async function updateProfile(payload: ProfileUpdatePayload): Promise<void> {
  const res: any = await jhzyRequest({ url: 'update_profile.php', method: 'POST', data: payload });
  if (!res || res.code !== 0) {
    throw classifyProfileError(res || { code: -1, msg: '保存失败' });
  }
}

// ============================== 修改密码（legacy：NO V2 IMPLEMENTATION） ==============================

/**
 * POST change_password.php —— 修改本人登录密码。
 * NO V2 IMPLEMENTATION：workers/src 全仓无 password 相关路由（已 grep 确认）。
 * 注意：本函数只负责提交；「成功后清除会话强制重登」由页面经 session.clearSession() 完成。
 */
export async function changePassword(oldPassword: string, newPassword: string, confirmPassword: string): Promise<void> {
  const res: any = await jhzyRequest({
    url: 'change_password.php',
    method: 'POST',
    data: {
      old_password: oldPassword,
      new_password: newPassword,
      confirm_password: confirmPassword,
    },
  });
  if (!res || (res.code !== 0 && res.code !== 200)) {
    throw classifyProfileError(res || { code: -1, msg: '修改密码失败' });
  }
}

// ============================== 上传头像（legacy：NO V2 IMPLEMENTATION） ==============================

interface LegacyAvatarUploadResponse {
  code: number;
  msg?: string;
  data?: { full_url?: string; avatar_url?: string };
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
 * POST upload_avatar.php（multipart）—— 上传头像，返回可直接展示的绝对 URL。
 * NO V2 IMPLEMENTATION：/api/v2/files 仅 purpose=community_attachment，且 V2 无头像绑定端点。
 * 仍走 wx.uploadFile（request.js 不支持 multipart），但 Header 经统一 buildHeaders、错误经统一分类。
 */
export async function uploadAvatar(tempFilePath: string, userId: string | number): Promise<string> {
  const token = getLegacyToken();
  if (!token) {
    throw classifyProfileError({ code: 401, msg: '登录信息失效，请重新登录' });
  }

  // contentType:'' → 不设 Content-Type，避免破坏 multipart boundary。
  const header = buildHeaders({ token, contentType: '' });

  const raw: LegacyAvatarUploadResponse = await new Promise<LegacyAvatarUploadResponse>((resolve, reject) => {
    wx.uploadFile({
      url: LEGACY_BASE + 'upload_avatar.php',
      filePath: tempFilePath,
      name: 'avatar',
      formData: { user_id: String(userId), token },
      header,
      success: (res: any) => {
        if (res.statusCode === 200) {
          const body = safeParse(res.data);
          if (!body) {
            reject(toApiError(0, null, true, { fallbackMessage: '服务器响应格式错误' }));
            return;
          }
          resolve(body as LegacyAvatarUploadResponse);
        } else {
          reject(
            toApiError(res.statusCode, safeParse(res.data), false, {
              fallbackMessage: `上传失败，服务器响应: ${res.statusCode}`,
            }),
          );
        }
      },
      fail: () => {
        reject(toApiError(0, null, true, { fallbackMessage: '上传失败：网络错误' }));
      },
    });
  });

  if (!raw || raw.code !== 0 || !raw.data) {
    throw classifyProfileError(raw || { code: -1, msg: '上传失败' });
  }
  return normalizeAvatarUrl(raw.data.full_url || raw.data.avatar_url || '');
}

// ============================== V2 投影（已具备能力，字段集有限） ==============================

export interface V2ProfileView {
  user: {
    public_id: string;
    nickname: string | null;
    cert_level: number;
    status: number;
    created_at?: number;
  };
  profile: {
    user_id: number;
    gender: number;
    birthday: string | null;
    region_code: string | null;
    bio: string | null;
  } | null;
  analytics_capabilities?: { team_view: boolean; platform_view: boolean };
}

/**
 * GET /api/v2/users/me —— V2 权威投影（P3-C 阶段唯一可用的 Profile V2 端点）。
 * 当前 Profile 页面不启用：V2 user_profiles 仅 gender/birthday/region_code/bio，
 * 不足以替换 user_profile.php 的字段集；保留为 V2 化就绪能力（由 Contract 覆盖）。
 */
export async function getV2Profile(): Promise<V2ProfileView> {
  return send<V2ProfileView>('GET', V2_BASE + '/users/me', undefined, {
    token: getV2Token(),
    teamScoped: false,
  });
}

export default {
  classifyProfileError,
  normalizeAvatarUrl,
  getProfile,
  updateProfile,
  changePassword,
  uploadAvatar,
  getV2Profile,
};
