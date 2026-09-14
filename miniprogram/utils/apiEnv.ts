// miniprogram/utils/apiEnv.ts
// Core Journey V2 API environment routing（STEP 3）。
//
// 唯一职责：解析 V2 API base URL。
//
// 安全契约（fail closed）：
//   release  -> 立即返回 production V2_BASE；**不读取** JHZY_V2_TEST_BASE；production behavior 不变。
//   develop  -> 只读取 wx.getStorageSync('JHZY_V2_TEST_BASE')。
//   trial    -> 同 develop。
//   缺失 / 空 / 非字符串 / 非法 URL / 指向 production host / 带 username|password -> THROW。
//   unknown env（envVersion 未知，或 getAccountInfoSync 不可用/抛错）-> THROW。
//   任何非 release 情形都【绝不】 fallback production。
//
// 本文件是唯一允许保存 production V2 literal 的授权文件。
// 不得在此保存任何真实 TEST Worker URL。

/** production V2 base（唯一来源） */
export const PRODUCTION_V2_BASE = 'https://api.jhzyfw.com/api/v2';

/** TEST override 的 wx storage key（值由开发者在 DevTools 手工注入，不入库） */
export const TEST_V2_BASE_STORAGE_KEY = 'JHZY_V2_TEST_BASE';

/** production hostname（精确相等判断，禁止模糊 includes） */
const PRODUCTION_HOSTNAME = 'api.jhzyfw.com';

interface ParsedUrl {
  protocol: string;
  hostname: string;
  username: string;
  password: string;
}

/**
 * 优先使用运行时 URL parser；若运行环境无 URL 构造器，使用等价的严格 parser。
 */
function parseUrl(raw: string): ParsedUrl | null {
  if (typeof URL !== 'undefined') {
    try {
      const u = new URL(raw);
      return {
        protocol: u.protocol,
        hostname: u.hostname,
        username: u.username,
        password: u.password,
      };
    } catch (e) {
      return null;
    }
  }
  // 严格 fallback parser（URL 语义子集：scheme / userinfo / host）
  const m = /^([a-zA-Z][a-zA-Z\d+\-.]*):\/\/(?:([^:@\/?#]*)(?::([^@\/?#]*))?@)?([^\/?#:]*)/.exec(raw);
  if (!m) return null;
  const host = m[4] || '';
  if (!host) return null;
  return {
    protocol: (m[1] || '').toLowerCase() + ':',
    hostname: host.toLowerCase(),
    username: m[2] || '',
    password: m[3] || '',
  };
}

/**
 * 判断 raw 是否缺少 authority（host）。
 * WHATWG URL 会把 "http:///api/v2" 静默修补为 hostname="api"，
 * 因此不能只依赖 new URL(...) 的 hostname，必须在 raw 上判断 authority 是否为空。
 */
function isEmptyAuthority(raw: string): boolean {
  const m = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\/([^\/?#]*)/.exec(raw);
  if (!m) return true;
  const authority = m[1];
  if (authority.length === 0) return true;
  const afterUserinfo = authority.split('@').pop() || '';
  const hostPart = afterUserinfo.split(':')[0];
  return hostPart.length === 0;
}

function detectEnvVersion(): string {
  if (typeof wx === 'undefined' || typeof wx.getAccountInfoSync !== 'function') {
    throw new Error('[apiEnv] 运行环境不可用（wx.getAccountInfoSync missing）；拒绝 fallback production。');
  }
  let envVersion: any;
  try {
    const info: any = wx.getAccountInfoSync();
    envVersion = info && info.miniProgram ? info.miniProgram.envVersion : undefined;
  } catch (e) {
    throw new Error('[apiEnv] 读取运行环境失败（getAccountInfoSync threw）；拒绝 fallback production。');
  }
  if (envVersion !== 'develop' && envVersion !== 'trial' && envVersion !== 'release') {
    throw new Error(
      '[apiEnv] 未知运行环境 envVersion=' + String(envVersion) + '；拒绝 fallback production。'
    );
  }
  return envVersion as string;
}

function readTestBase(envVersion: string): string {
  let raw: any;
  try {
    raw = wx.getStorageSync(TEST_V2_BASE_STORAGE_KEY);
  } catch (e) {
    throw new Error('[apiEnv] 读取 TEST override 失败；拒绝 fallback production。');
  }
  if (typeof raw !== 'string') {
    throw new Error(
      '[apiEnv] envVersion=' +
        envVersion +
        ' 需要 TEST override：storage key "' +
        TEST_V2_BASE_STORAGE_KEY +
        '" 缺失或非字符串；拒绝 fallback production。'
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error('[apiEnv] TEST override 为空；拒绝 fallback production。');
  }
  const parsed = parseUrl(trimmed);
  if (!parsed) {
    throw new Error('[apiEnv] TEST override 不是合法 URL；拒绝 fallback production。');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      '[apiEnv] TEST override protocol 只允许 http:/https:，实际=' + parsed.protocol + '；拒绝。'
    );
  }
  if (!parsed.hostname || parsed.hostname.length === 0) {
    throw new Error('[apiEnv] TEST override hostname 为空；拒绝。');
  }
  if (isEmptyAuthority(trimmed)) {
    throw new Error('[apiEnv] TEST override 缺少 host（authority 为空）；拒绝。');
  }
  if (parsed.hostname === PRODUCTION_HOSTNAME) {
    throw new Error(
      '[apiEnv] TEST override 不得指向 production host（hostname === ' +
        PRODUCTION_HOSTNAME +
        '）；拒绝。'
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error('[apiEnv] TEST override 不得包含 username/password；拒绝。');
  }
  // normalize trailing slash
  return trimmed.replace(/\/+$/, '');
}

/**
 * 解析 V2 API base URL。
 * release        -> PRODUCTION_V2_BASE（不读取 TEST override）
 * develop/trial  -> storage 中的 TEST override（缺失/非法 -> THROW）
 * unknown        -> THROW
 */
export function resolveV2Base(): string {
  const envVersion = detectEnvVersion();
  if (envVersion === 'release') {
    return PRODUCTION_V2_BASE;
  }
  return readTestBase(envVersion);
}

export default resolveV2Base;
