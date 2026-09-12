/**
 * 站内通知 target_page 内部 allowlist + validator（N0-F2 · N0-F1 H1 硬化）。
 *
 * 问题（H1）：target_page 此前只有【前端单侧】校验（miniprogram/pages/message/message.ts
 * 的 EXACT_PATHNAME_ALLOWLIST_PLUS_PARAM_VALIDATION），服务端写入侧没有显式的
 * 内部页面白名单 / 参数校验；也无法阻止未来某个业务事件把外部 URL、任意小程序路径
 * 或 javascript:/data: schema 写进 notifications.target_page。
 *
 * 本模块是【服务端唯一】的 target_page SSOT：
 *   - 显式 pathname 白名单（精确匹配，禁前缀 / 包含 / 正则模糊匹配）；
 *   - 每个 pathname 只允许显式声明的参数名，参数值必须有 validator；
 *   - 服务端权威构造（buildInternalTarget / buildActivityDetailTarget）：
 *     只用白名单里的 pathname + 已校验参数重新拼装，绝不透传调用方传入的原始字符串。
 *
 * 与 WeChat `page` 参数的关系：
 *   WeChat subscribeMessage.send 的 page 采用同一形如 `/pages/detail/detail?id=<ULID>`
 *   的内部页面形态，故本 validator 【可安全复用】（同一 ULID 规则、同一白名单）。
 *   N0-F2 阶段 WECHAT = DEFERRED，本模块【不】被 WeChat adapter / schema / provider 引用
 *   （第 §7 禁止项）；共享只体现在规则定义层面，不改动任何 WeChat 代码。
 *
 * 本地严格度对齐前端：不做 URL 解码（拒绝 '%'），从而杜绝百分号编码绕过；
 * 同时拒绝协议头（`:`）、协议相对（`//`）、上级目录（`..`）、`#`、空白与控制字符。
 */

import { isUlid } from './validation';
import { invalidParam } from './errors';

/** target_page 长度上限（与 notification-service.ts MAX_TARGET_PAGE 一致）。 */
export const MAX_INTERNAL_TARGET_LENGTH = 200;

export interface InternalTargetParamRule {
  /** 参数名（query key）。 */
  name: string;
  /** 参数值校验器；返回 false → 该 target 非法。 */
  validate(value: string): boolean;
}

export interface InternalTargetRule {
  /** 无前导 '/' 的 pathname（与 app.json 页面路径一致）。 */
  pathname: string;
  /** 该页面允许的全部参数；必须【全部出现】且【无额外参数】。 */
  params: readonly InternalTargetParamRule[];
}

/**
 * 站内通知允许跳转的内部页面白名单。
 *
 * 冻结：只收录【已有正式 notification target】的页面（当前仅活动详情页，
 * N0-E1 / N0-E2 / N0-F2 共用）。不为未来事件提前扩展。
 */
export const INTERNAL_NOTIFICATION_TARGET_ALLOWLIST: Readonly<
  Record<string, InternalTargetRule>
> = Object.freeze({
  'pages/detail/detail': Object.freeze({
    pathname: 'pages/detail/detail',
    params: Object.freeze([{ name: 'id', validate: (v: string) => isUlid(v) }]),
  }),
});

/** 全局允许字符集：字母数字 + `/ . - _ ? = &`。刻意排除 `% : # \` 与空白。 */
const TARGET_CHARSET_RE = /^[A-Za-z0-9/._\-?=&]+$/;

export interface ParsedInternalTarget {
  pathname: string;
  params: Record<string, string>;
}

/**
 * 解析并校验一个 target_page。
 *
 * 任何不合法（非字符串 / 空 / 超长 / 非法字符 / 协议头 / `..` / 非白名单页面 /
 * 参数缺失 / 参数多余 / 参数重复 / 参数值非法）→ 返回 null。
 * 合法 → 返回规范化后的 { pathname, params }（不含原始字符串）。
 */
export function parseInternalTarget(raw: unknown): ParsedInternalTarget | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (raw.length > MAX_INTERNAL_TARGET_LENGTH) return null;
  if (!TARGET_CHARSET_RE.test(raw)) return null;
  if (raw.includes('..')) return null;

  const qIdx = raw.indexOf('?');
  let pathPart = qIdx === -1 ? raw : raw.slice(0, qIdx);
  const queryPart = qIdx === -1 ? '' : raw.slice(qIdx + 1);

  if (pathPart.startsWith('/')) pathPart = pathPart.slice(1);
  if (pathPart === '' || pathPart.includes('//')) return null;

  const rule = INTERNAL_NOTIFICATION_TARGET_ALLOWLIST[pathPart];
  if (!rule) return null;

  const params: Record<string, string> = {};
  if (queryPart !== '') {
    for (const seg of queryPart.split('&')) {
      if (seg === '') return null;
      const eq = seg.indexOf('=');
      if (eq <= 0) return null;
      const key = seg.slice(0, eq);
      const value = seg.slice(eq + 1);
      if (Object.prototype.hasOwnProperty.call(params, key)) return null; // 重复 key
      params[key] = value;
    }
  }

  // 参数集合必须与白名单【精确相等】：既不许缺，也不许多。
  const declared = rule.params.map((p) => p.name);
  const provided = Object.keys(params);
  if (provided.length !== declared.length) return null;
  for (const name of provided) {
    if (!declared.includes(name)) return null;
  }
  for (const pr of rule.params) {
    const v = params[pr.name];
    if (typeof v !== 'string' || !pr.validate(v)) return null;
  }

  return { pathname: rule.pathname, params };
}

/** 布尔便捷形式。 */
export function isValidInternalTarget(raw: unknown): boolean {
  return parseInternalTarget(raw) != null;
}

/**
 * 服务端权威构造：仅用白名单 pathname + 已校验参数重新拼装 target。
 * 任何不支持 → 抛 400 INVALID_PARAM（先于任何 DB 写入）。
 */
export function buildInternalTarget(
  pathname: string,
  params: Record<string, string>,
): string {
  const rule = INTERNAL_NOTIFICATION_TARGET_ALLOWLIST[pathname];
  if (!rule) throw invalidParam('target_page', 'unsupported internal page');

  const provided = Object.keys(params);
  const declared = rule.params.map((p) => p.name);
  if (provided.length !== declared.length) {
    throw invalidParam('target_page', 'unsupported parameters');
  }
  for (const name of provided) {
    if (!declared.includes(name)) throw invalidParam('target_page', 'unsupported parameters');
  }

  const parts: string[] = [];
  for (const pr of rule.params) {
    const v = params[pr.name];
    if (typeof v !== 'string' || !pr.validate(v)) {
      throw invalidParam(`target_page.${pr.name}`, 'invalid value');
    }
    parts.push(`${pr.name}=${v}`);
  }

  const built = `/${rule.pathname}` + (parts.length > 0 ? `?${parts.join('&')}` : '');
  // 自校验：构造结果必须能被同一 validator 接受（防止 allowlist 与构造逻辑漂移）。
  if (!isValidInternalTarget(built)) {
    throw invalidParam('target_page', 'internal target failed self-validation');
  }
  return built;
}

/** 活动详情页 target（N0-E1 / N0-E2 / N0-F2 的唯一构造入口）。 */
export function buildActivityDetailTarget(activityPublicId: string): string {
  return buildInternalTarget('pages/detail/detail', { id: activityPublicId });
}
