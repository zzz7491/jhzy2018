/**
 * P3-E Feedback V2 Migration —— 前端静态契约（Backend Authority）。
 *
 * 校验目标：
 *   1) 新增用户端 Feedback 域唯一接入层 utils/feedbackApi.ts（提交反馈 / 上传反馈图片）。
 *   2) 用户端 feedback 页不再散落 wx.request / wx.uploadFile / 裸读 token / 硬编码 API host。
 *   3) 令牌经 Session Manager，错误统一经 classifyFeedbackError（五类）。
 *   4) Backend Authority 逐能力断言（前端调用形状 vs workers/src 真实实现，禁止伪造）：
 *        - Submit Feedback      → Legacy feedback_submit.php（NO V2 IMPLEMENTATION）
 *        - Upload Feedback Img  → Legacy upload_feedback_image.php（NO V2 IMPLEMENTATION）
 *        - GET/POST/PATCH/DELETE /api/v2/feedback → 后端确不存在（扫描证据）
 *   5) Admin 域（pages/admin/feedback-manage）本阶段【不纳管】：保持原样，未迁移。
 *
 * 运行：node miniprogram/tests/feedback_v2_contract.mjs
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES = join(HERE, '..', 'pages');
const UTILS = join(HERE, '..', 'utils');
const WORKERS = join(HERE, '..', '..', 'workers', 'src');

const read = (p) => readFileSync(p, 'utf8');
const isFile = (p) => existsSync(p) && statSync(p).isFile();
const readMaybe = (p) => (isFile(p) ? readFileSync(p, 'utf8') : '');
/** 递归读取某目录下所有文件文本（目录/子目录均安全跳过）。 */
function readTree(dir) {
  if (!existsSync(dir)) return '';
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(readMaybe(full));
    }
  };
  walk(dir);
  return out.join('\n');
}

/**
 * 去注释后的源码（负向断言只对【真实代码】生效，避免注释里的规则描述造成误报）。
 * 注意：跳过 `://` 内的 `//`（如 https://），不破坏字符串。
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '');
}

let pass = 0;
let fail = 0;
function check(cond, name) {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    console.error('  FAIL: ' + name);
  }
}

const F = {
  feedbackApi: read(join(UTILS, 'feedbackApi.ts')),
  page: read(join(PAGES, 'feedback', 'feedback.ts')),
  adminPage: read(join(PAGES, 'admin', 'feedback-manage', 'index.ts')),
  beApp: read(join(WORKERS, 'app.ts')),
  beFiles: read(join(WORKERS, 'routes', 'files.ts')),
  beContent: read(join(WORKERS, 'routes', 'content.ts')),
  beUsers: read(join(WORKERS, 'routes', 'users.ts')),
};
const BE_ROUTE_NAMES = readdirSync(join(WORKERS, 'routes'));
const BE_ROUTES_ALL = BE_ROUTE_NAMES.map((n) => read(join(WORKERS, 'routes', n))).join('\n');
const BE_SERVICES = readTree(join(WORKERS, 'services'));
const BE_REPO = readTree(join(WORKERS, 'repository'));

// =========================================================================
// 1) Feedback 域唯一接入层
// =========================================================================
check(/export function classifyFeedbackError/.test(F.feedbackApi), 'WRAPPER_EXISTS: feedbackApi.classifyFeedbackError');
check(/export async function submitFeedback/.test(F.feedbackApi), 'WRAPPER_EXISTS: feedbackApi.submitFeedback');
check(/export async function uploadFeedbackImage/.test(F.feedbackApi), 'WRAPPER_EXISTS: feedbackApi.uploadFeedbackImage');

check(/from '\.\/transport'/.test(F.feedbackApi), 'TRANSPORT_USED: feedbackApi 复用统一 transport（buildHeaders / toApiError）');
check(/from '\.\/session'/.test(F.feedbackApi), 'SESSION_USED: feedbackApi 复用统一 session');
check(/from '\.\/request'/.test(F.feedbackApi), 'LEGACY_TRANSPORT_USED: feedbackApi 走 jhzyRequest（legacy）');
check(/getLegacyToken\(\)/.test(F.feedbackApi), 'TOKEN_VIA_SESSION: 令牌经 session.getLegacyToken，不裸读 storage');
// 负向断言一律对【去注释代码】生效
check(!/wx\.request\(/.test(F.feedbackApi), 'NO_RAW_WXREQUEST_IN_WRAPPER: wrapper 不裸调 wx.request');
check(/wx\.uploadFile\(/.test(F.feedbackApi), 'UPLOADFILE_CONFINED_TO_WRAPPER: multipart 仅存在于 wrapper');
check(
  !/wx\.(get|set)StorageSync\(/.test(F.feedbackApi),
  'NO_RAW_STORAGE_IN_WRAPPER: wrapper 经 session 读写，不裸碰 storage',
);
// wrapper 不得引用任何 V2 请求基座（本域 V2 端点为零，走 V2 即为伪造）
check(
  !/resolveV2Base|V2_BASE|V2_ROOT/.test(F.feedbackApi),
  'NO_V2_BASE_IN_WRAPPER: wrapper 不持有任何 V2 请求基座（V2 feedback 端点不存在）',
);

// =========================================================================
// 2) 页面改用 feedbackApi；禁止裸网络调用 / 硬编码 host / 裸读 token
// =========================================================================
check(/from '\.\.\/\.\.\/utils\/feedbackApi'/.test(F.page), 'PAGE_IMPORTS_FEEDBACKAPI');
check(/submitFeedbackToServer\(\{/.test(F.page), 'PAGE_USES_submitFeedback');
check(/uploadFeedbackImage\(imagePath\)/.test(F.page), 'PAGE_USES_uploadFeedbackImage');
check(/classifyFeedbackError\(/.test(F.page), 'PAGE_USES_classifyFeedbackError');

const PAGE_CODE = stripComments(F.page);
const ADMIN_CODE = stripComments(F.adminPage);

check(!/wx\.request\(/.test(PAGE_CODE), 'NO_RAW_WXREQUEST_PAGE: 页面无裸 wx.request');
check(!/wx\.uploadFile\(/.test(PAGE_CODE), 'NO_RAW_UPLOADFILE_PAGE: 页面无裸 wx.uploadFile');
check(!/getStorageSync\(/.test(PAGE_CODE), 'NO_TOKEN_RAW_READ_PAGE: 页面不裸读任何 storage');
check(!/api\.jhzyfw\.com/.test(PAGE_CODE), 'NO_HARDCODED_HOST_PAGE: 页面无硬编码 API host');
check(!/apiBaseUrl/.test(PAGE_CODE), 'NO_BASEURL_ASSEMBLY_PAGE: 页面不再自行拼装 API URL');
// 页面仅依赖 Feedback 域 wrapper，不引入其它业务域
for (const other of ['activityApi', 'teamApi', 'profileApi', 'adminApi', 'pointsApi', 'transport', "from '../../utils/request'"]) {
  check(!PAGE_CODE.includes(other), `PAGE_NO_OTHER_WRAPPER_${other}: 页面不引用 ${other}`);
}

// =========================================================================
// 3) 统一错误分类（五类）
// =========================================================================
for (const kind of ['backend', 'network', 'unauthorized', 'expired', 'denied']) {
  check(F.feedbackApi.includes(`'${kind}'`), `ERROR_KIND_${kind.toUpperCase()}: 错误分类含 ${kind}`);
}

// =========================================================================
// 4) Backend Authority —— 逐能力核对（禁止伪造 V2）
// =========================================================================

// 4.1 提交反馈 → Legacy（NO V2 IMPLEMENTATION），成功契约 code === 200
check(/'feedback_submit\.php'/.test(F.feedbackApi), 'BA_SUBMIT_LEGACY: 提交反馈走 legacy feedback_submit.php');
check(/res\.code !== 200/.test(F.feedbackApi), 'BA_SUBMIT_CODE200: 沿用该端点 code===200 成功契约（禁止套用 Admin 的 code===0）');
check(
  /timestamp/.test(F.feedbackApi) && /images/.test(F.feedbackApi) && /contact/.test(F.feedbackApi),
  'BA_SUBMIT_PAYLOAD_KEPT: type/content/contact/images/timestamp 字段保持原样',
);

// 4.2 上传反馈图片 → Legacy（NO V2 IMPLEMENTATION），multipart 字段名 file
check(/'upload_feedback_image\.php'/.test(F.feedbackApi), 'BA_IMAGE_LEGACY: 反馈图片走 legacy upload_feedback_image.php');
check(/name: 'file'/.test(F.feedbackApi), 'BA_IMAGE_FIELD_NAME: multipart 字段名仍为 file');
check(
  !/\/api\/v2\/files/.test(stripComments(F.feedbackApi)),
  'BA_IMAGE_NOT_V2_FILES: 不冒用 V2 /files（仅 community_attachment）',
);

// 4.3 V2 后端确无 Feedback 实现（扫描证据，禁止猜测）
check(!/v2\.route\('\/feedback'/.test(F.beApp), 'BA_V2_NO_MOUNT: app.ts 未挂载 /api/v2/feedback');
check(
  !BE_ROUTE_NAMES.some((n) => /feedback|suggestion|complaint/i.test(n)),
  'BA_V2_NO_ROUTE_FILE: workers/src/routes 无 feedback 路由文件',
);
check(!/feedback/i.test(BE_ROUTES_ALL), 'BA_V2_NO_ROUTE_IMPL: 路由实现中零 feedback 命中');
check(!/feedback/i.test(BE_SERVICES), 'BA_V2_NO_SERVICE: services 层零 feedback 命中');
check(!/feedback/i.test(BE_REPO), 'BA_V2_NO_REPOSITORY: repository 层零 feedback 命中');

// 4.4 content.report 属社区内容举报，不可复用为意见反馈
check(
  /content\.report\.create/.test(F.beContent) || /report/.test(F.beContent),
  'BA_CONTENT_REPORT_DIFFERENT_DOMAIN: content.ts 的 report 是社区举报，非意见反馈',
);

// 4.5 /api/v2/files 仅 community_attachment → 反馈图片不可走 V2
check(/community_attachment/.test(F.beFiles), 'BA_FILES_PURPOSE_LIMITED: V2 files 仅 community_attachment');

// 4.6 wrapper 必须显式标注能力来源（禁止静默 legacy）
check(/NO V2 IMPLEMENTATION/.test(F.feedbackApi), 'BA_ANNOTATED: wrapper 显式标注 NO V2 IMPLEMENTATION');
check(/Keep legacy endpoint until V2 backend exists\./.test(F.feedbackApi), 'BA_RETENTION_ANNOTATED: 标注保留 legacy 直至 V2 就绪');

// =========================================================================
// 5) 作用域边界 —— Admin 域本阶段不纳管（用户决策 1=A）：保持原样、未迁移
// =========================================================================
check(
  /admin_get_feedbacks\.php|admin_reply_feedback\.php|admin_update_feedback\.php/.test(F.adminPage),
  'SCOPE_ADMIN_UNTouched: Admin 反馈管理页仍直连 admin_* legacy 端点（本阶段不改）',
);
check(
  !/utils\/feedbackApi/.test(ADMIN_CODE),
  'SCOPE_ADMIN_NOT_MIGRATED: Admin 页未纳入本次 wrapper（范围外）',
);

// 禁止跨域：wrapper【导入】不得触碰其它业务域（Profile / Team / Activity / Admin / Points）
// 说明：仅校验 import 语句，wrapper 头部的范式说明文字不构成跨域。
for (const forbidden of ['profileApi', 'teamApi', 'activityApi', 'adminApi', 'pointsApi']) {
  check(
    !new RegExp(`from '\\./${forbidden}'`).test(F.feedbackApi),
    `NO_CROSS_DOMAIN_${forbidden.toUpperCase()}: wrapper 不导入其它业务域 wrapper`,
  );
}

if (fail > 0) {
  console.error(`\n  ${fail} assertion(s) failed.`);
  process.exit(1);
}
console.log(`  Feedback V2 contract: ${pass} assertions PASS`);
