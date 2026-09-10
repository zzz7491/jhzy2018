/**
 * P35-C3 — Service Time Adjustment Approval · ADMIN FRONTEND CONTRACT TEST
 *
 * 目的：以静态契约检查（read-only）验证管理端前端已接入 P35-C2 冻结的
 * 「服务时长调整 申请 → 双人审批」后端，且：
 *   - 旧 direct adjust（POST /service-records/:id/adjust）在前端已彻底消失；
 *   - UI 正确区分「当前有效时长」与「待审核的申请时长」（PENDING 不覆盖主时长）；
 *   - 状态 0/1/2/3 均可渲染；approve/reject 仅在具备审核能力的路径出现；
 *   - STALE / PENDING_EXISTS 等错误有显式 UX；
 *   - 不渲染任何 numeric 内部 ID；不做前端 RBAC 扩张。
 *
 * 为什么是静态检查：小程序（miniprogram/）不在 workers 的 node:sqlite + esbuild harness 中运行，
 * 故直接对前端源码做契约断言（与 p34_c4_activity_frontend_contract.mjs 同款模式）。
 *
 * 覆盖：A–T（任务 §12）+ U（P35-C3B：capability 投影消费 / requester 安全身份展示）。
 * 后端真实（role → capability）矩阵见 p35_c2 场景 AL。
 *
 * 运行：node workers/tests/p35_c3_service_time_adjustment_frontend_contract.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.join(__dirname, '../../miniprogram');

// ============================ 工具 ============================

const results = [];

function check(name, condition, detail = '') {
  results.push({ name, pass: !!condition, detail });
}

function readFile(rel) {
  return fs.readFileSync(path.join(FRONTEND_ROOT, rel), 'utf8');
}

/** 去除 JS/TS 注释，避免把注释里提到的旧端点误判为"仍在调用"。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 去除 WXML 注释。 */
function stripWxmlComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, '');
}

/** 递归收集某目录下所有 .ts 文件（相对 FRONTEND_ROOT）。 */
function collectTs(dirRel, acc = []) {
  const abs = path.join(FRONTEND_ROOT, dirRel);
  if (!fs.existsSync(abs)) return acc;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dirRel, entry.name);
    if (entry.isDirectory()) collectTs(rel, acc);
    else if (entry.name.endsWith('.ts')) acc.push(rel);
  }
  return acc;
}

// ============================ 读取目标文件 ============================

const adminApiSrc = readFile('utils/adminApi.ts');
const adminApiCode = stripComments(adminApiSrc);

const pageSrc = readFile('pages/admin/service-records/index.ts');
const pageCode = stripComments(pageSrc);

const pageWxmlRaw = readFile('pages/admin/service-records/index.wxml');
const pageWxml = stripWxmlComments(pageWxmlRaw);
const pageWxss = readFile('pages/admin/service-records/index.wxss');
const pageJson = readFile('pages/admin/service-records/index.json');

const panelCode = stripComments(readFile('pages/adminPanel/adminPanel.ts'));
const panelWxml = stripWxmlComments(readFile('pages/adminPanel/adminPanel.wxml'));

const appJson = readFile('app.json');

const allTs = collectTs('').map((rel) => ({ rel, code: stripComments(readFile(rel)) }));

// ============================ A / B / C / D：API wrapper 契约 ============================

check(
  'A 提交申请 wrapper 存在（requestServiceRecordAdjustment → POST /service-records/:id/adjustments）',
  /requestServiceRecordAdjustment\(/.test(adminApiCode) &&
    adminApiCode.includes('/service-records/${serviceRecordPublicId}/adjustments'),
  'request wrapper present',
);

check(
  'B 申请历史 wrapper 存在（listServiceRecordAdjustments → GET /service-records/:id/adjustments）',
  /listServiceRecordAdjustments\(/.test(adminApiCode) &&
    /'GET',\s*`\/service-records\/\$\{serviceRecordPublicId\}\/adjustments`/.test(adminApiCode),
  'history wrapper present',
);

check(
  'C 审批通过 wrapper 存在（approveServiceRecordAdjustment → POST /service-record-adjustments/:id/approve）',
  /approveServiceRecordAdjustment\(/.test(adminApiCode) &&
    adminApiCode.includes('/service-record-adjustments/${adjustmentPublicId}/approve'),
  'approve wrapper present',
);

check(
  'D 拒绝 wrapper 存在（rejectServiceRecordAdjustment → POST /service-record-adjustments/:id/reject + reason）',
  /rejectServiceRecordAdjustment\(/.test(adminApiCode) &&
    adminApiCode.includes('/service-record-adjustments/${adjustmentPublicId}/reject') &&
    adminApiCode.includes('{ reason }'),
  'reject wrapper present',
);

// ============================ E：旧 direct adjust 前端调用必须消失 ============================

// 匹配 /adjust 或 /adjust' 但排除 /adjustments（负向前瞻）。
const directAdjustHits = allTs
  .filter((f) => /\/adjust(?![a-zA-Z])/.test(f.code))
  .map((f) => f.rel);
check(
  'E1 前端无任何旧 direct /adjust 端点调用（仅允许 /adjustments）',
  directAdjustHits.length === 0,
  directAdjustHits.length ? `命中: ${directAdjustHits.join(', ')}` : 'no live /adjust endpoint',
);

const oldFnHits = allTs
  .filter((f) => /adjustServiceRecord\s*\(/.test(f.code) || /\.adjustServiceRecord\b/.test(f.code))
  .map((f) => f.rel);
check(
  'E2 无 adminApi.adjustServiceRecord 定义或调用',
  oldFnHits.length === 0,
  oldFnHits.length ? `命中: ${oldFnHits.join(', ')}` : 'direct adjust fn removed',
);

// ============================ F / G：表单校验 ============================

check(
  'F 表单校验分钟数（整数 + 0–525600 上界）',
  pageCode.includes('Number.isInteger(minutes)') &&
    pageCode.includes('minutes > ADJUSTMENT_MINUTES_MAX') &&
    pageCode.includes('请输入整数分钟数') &&
    adminApiSrc.includes('ADJUSTMENT_MINUTES_MAX = 525600'),
  'minutes integer + range validated',
);

check(
  'G 表单校验原因（trim 后非空 + ≤500）',
  /const reason = \(this\.data\.requestReason \|\| ''\)\.trim\(\);/.test(pageCode) &&
    pageCode.includes('请填写调整原因') &&
    pageCode.includes('ADJUSTMENT_REJECT_REASON_MAX') &&
    adminApiSrc.includes('ADJUSTMENT_REJECT_REASON_MAX = 500'),
  'reason trim + max 500 validated',
);

// ============================ H：PENDING 不得替换当前有效时长 ============================

check(
  'H1 主时长只取自当前记录（currentMinutes = selected.minutes）',
  pageCode.includes('currentMinutes: selected ? selected.minutes : 0') &&
    !/currentMinutes\s*:\s*[^,\n]*requested_minutes/.test(pageCode),
  'main minutes from record only',
);
check(
  'H2 待审核区独立展示「当前时长」与「申请调整为」（不写回主时长）',
  pageWxml.includes('当前时长：{{currentMinutes}}') &&
    pageWxml.includes('申请调整为：{{pendingAdjustment.requested_minutes}}'),
  'pending shown separately from main duration',
);
check(
  'H3 WXML 不把申请值渲染进主时长位（currentMinutes 不绑定 requested_minutes）',
  pageWxml.includes('{{currentMinutes}}') && !/currentMinutes[^}]*requested_minutes/.test(pageWxml),
  'no requested->main substitution',
);

// ============================ I / J / K / L：状态 0/1/2/3 均可渲染 ============================

const labelBlock = adminApiSrc.slice(
  adminApiSrc.indexOf('ADJUSTMENT_STATUS_LABELS'),
  adminApiSrc.indexOf('ADJUSTMENT_STATUS_LABELS') + 220,
);
const hasPending = /0:\s*'待审核'/.test(labelBlock);
const hasApproved = /1:\s*'已批准'/.test(labelBlock);
const hasRejected = /2:\s*'已拒绝'/.test(labelBlock);
const hasCancelled = /3:\s*'已取消'/.test(labelBlock);

check('I PENDING(0) 状态渲染（待审核）', hasPending && pageWxml.includes('{{item.status_label}}'), `pending=${hasPending}`);
check('J APPROVED(1) 状态渲染（已批准）', hasApproved, `approved=${hasApproved}`);
check('K REJECTED(2) 状态渲染（已拒绝）', hasRejected, `rejected=${hasRejected}`);
check('L CANCELLED(3) 状态渲染（已取消）', hasCancelled, `cancelled=${hasCancelled}`);
check(
  'L2 状态文案未知值兜底为"未知"（不臆造为已批准）',
  adminApiSrc.includes("return ADJUSTMENT_STATUS_LABELS[status] || '未知';"),
  'unknown fallback',
);

// ============================ M：审核操作仅在具备审核能力的路径 ============================

check(
  'M1 can_approve = PENDING 且具备审核能力（isPending && canReview）',
  /can_approve:\s*isPending && canReview/.test(pageCode),
  'approve gated on pending + canReview',
);
check(
  'M2 通过/拒绝按钮仅在 item.can_approve 时渲染',
  pageWxml.includes('wx:if="{{item.can_approve}}"') &&
    pageWxml.includes('bindtap="approveAdjustment"') &&
    pageWxml.includes('bindtap="openRejectModal"'),
  'approve/reject UI gated',
);
check(
  'M3 审核能力来自后端 capabilities（非 legacy role 推断）',
  pageCode.includes('canReview') &&
    !/computeCanReview/.test(pageCode) &&
    /caps\.can_review_adjustment/.test(pageCode),
  'capability-driven review hint',
);

// ============================ N：拒绝必须填写原因 ============================

check(
  'N1 拒绝原因必填（trim 后非空 + ≤500）',
  /const reason = \(this\.data\.rejectReason \|\| ''\)\.trim\(\);/.test(pageCode) &&
    pageCode.includes('请填写拒绝原因'),
  'reject reason required',
);
check(
  'N2 拒绝输入 UI 为 textarea 且绑定输入',
  pageWxml.includes('class="reject-textarea"') && pageWxml.includes('bindinput="onRejectInput"'),
  'reject textarea bound',
);

// ============================ O：STALE 显式 UX（不自动 retry） ============================

check(
  'O1 STALE_REQUEST 显式提示需重新提交新的调整申请',
  pageCode.includes('记录已发生变化，需要重新提交新的调整申请') && pageCode.includes('showStaleNotice'),
  'explicit stale UX',
);
check(
  'O2 STALE 不自动 retry（无自动重新提交/自动 approve 循环）',
  !/setTimeout\([\s\S]{0,200}(approve|submit|retry)/i.test(pageCode) &&
    !/while\s*\(/.test(pageCode),
  'no auto-retry',
);
check(
  'O3 STALE token 识别基于后端 details.reason',
  pageCode.includes("reasonOf(err)") && /err\.details\.reason/.test(pageCode),
  'detects adjustment_stale token',
);

// ============================ P：PENDING_EXISTS 显式处理 ============================

check(
  'P1 PENDING_EXISTS 被显式处理（前端拦截 + 后端 token 文案）',
  pageCode.includes('adjustment_pending_exists') && pageCode.includes('该服务记录已有待审核申请'),
  'pending-exists handled',
);
check(
  'P2 INVALID_TRANSITION token 被处理',
  pageCode.includes('adjustment_invalid_transition'),
  'invalid-transition handled',
);
check(
  'P3 NOT_ALLOWABLE token 被处理',
  pageCode.includes('adjustment_not_allowable'),
  'not-allowable handled',
);

// ============================ Q：approve 成功刷新 record + history ============================

check(
  'Q1 审批通过成功后同时刷新 service record 与 history',
  /approveServiceRecordAdjustment\(id\)[\s\S]{0,800}?loadRecords\(\)[\s\S]{0,200}?loadAdjustments\(/.test(pageCode),
  'approve refreshes record + history',
);
check(
  'Q2 审批通过先确认动作（无 optimistic UI）',
  pageCode.includes("title: '确认审批通过'"),
  'confirm action before approve',
);

// ============================ R：reject 成功仅刷新 history（不改主时长） ============================

check(
  'R1 拒绝成功后仅刷新 history（不刷新 record、不改主时长）',
  /confirmReject[\s\S]*?rejectServiceRecordAdjustment\(id, reason\)[\s\S]{0,600}?loadAdjustments\(selected\.public_id\)/.test(
    pageCode,
  ) &&
    !/rejectServiceRecordAdjustment\(id, reason\)[\s\S]{0,600}?loadRecords\(/.test(pageCode),
  'reject refreshes history only',
);
check(
  'R2 提交申请后不改变主时长（仅刷新 history）',
  /requestServiceRecordAdjustment\(selected\.public_id[\s\S]{0,700}?loadAdjustments\(selected\.public_id\)/.test(
    pageCode,
  ) &&
    !/requestServiceRecordAdjustment\(selected\.public_id[\s\S]{0,700}?currentMinutes\s*:/.test(pageCode),
  'submit does not mutate main duration',
);
// currentMinutes 的每一次赋值都必须来源于后端记录（selected.minutes）或初值 0；
// 且 setData 绝不写 minutes 顶层键 / 绝不用 requested_minutes 作为主时长。
const cmAssignments = (pageCode.match(/currentMinutes\s*:\s*([^,\n]+)/g) || []).map((s) => s.trim());
const cmAllLegit = cmAssignments.length > 0 && cmAssignments.every((a) => /selected\.minutes/.test(a) || /:\s*0$/.test(a));
// 仅在真实 setData 对象块内检查是否写了 minutes 顶层键（避免跨语句误判 toRecordView 的返回键）。
const setDataBlocks = pageCode
  .split('setData(')
  .slice(1)
  .map((s) => s.slice(0, Math.max(0, s.indexOf('}'))));
const writesMinutesKey = setDataBlocks.some((b) => /\n\s*minutes\s*:/.test(b));
const writesRequestedAsMain = /currentMinutes\s*:\s*[^,\n]*requested_minutes/.test(pageCode);
check(
  'R3 不伪造落地时长（currentMinutes 仅源自后端记录/初值 0；setData 不写 minutes 键）',
  cmAllLegit && !writesMinutesKey && !writesRequestedAsMain,
  `cm=${cmAssignments.length} writeMinutesKey=${writesMinutesKey} requestedAsMain=${writesRequestedAsMain}`,
);

// ============================ S：禁渲染 numeric 内部 ID ============================

check(
  'S1 申请 API 仅使用 public_id（签名参数为 publicId）',
  /requestServiceRecordAdjustment\(\s*serviceRecordPublicId: string/.test(adminApiCode) &&
    /approveServiceRecordAdjustment\(\s*adjustmentPublicId: string/.test(adminApiCode) &&
    /rejectServiceRecordAdjustment\(\s*adjustmentPublicId: string/.test(adminApiCode),
  'public_id only',
);
check(
  'S2 AdjustmentRequestView 不含 numeric 内部 id 字段',
  /export interface AdjustmentRequestView \{[\s\S]*?\}/.test(adminApiSrc) &&
    !/export interface AdjustmentRequestView \{[\s\S]*?\b(id|requester_id|reviewer_id|team_id)\s*:\s*number/.test(adminApiSrc),
  'no numeric id fields in DTO',
);
check(
  'S3 WXML 使用 data-id={{item.public_id}}（非 item.id）',
  pageWxml.includes('data-id="{{item.public_id}}"') && !pageWxml.includes('data-id="{{item.id}}"'),
  'public_id as key',
);
check(
  'S4 页面不读取 requester_id / reviewer_id / team_id',
  !/\b(requester_id|reviewer_id)\b/.test(pageCode) &&
    !/\bteam_id\b/.test(pageCode),
  'no numeric actor/team id read',
);

// ============================ T：不做前端 RBAC 扩张 ============================

const permStringHits = allTs
  .filter((f) => /service\.record\.(adjust|review|view|read)/.test(f.code))
  .map((f) => f.rel);
check(
  'T1 前端不引入任何 service.record.* 权限码（RBAC 由后端裁决）',
  permStringHits.length === 0,
  permStringHits.length ? `命中: ${permStringHits.join(', ')}` : 'no permission codes in frontend',
);
check(
  'T2 页面无新增角色→权限矩阵（仅 role 显示判定）',
  !/role_permissions|permissions\s*:\s*\[/.test(pageCode),
  'no role->permission matrix in UI',
);

// ============================ 附加：集成可达性 ============================

check(
  'X1 页面已在 app.json 注册',
  appJson.includes('pages/admin/service-records/index'),
  'page registered',
);
check(
  'X2 adminPanel 入口已指向新页面（goToServiceRecords → navigateTo）',
  /goToServiceRecords\(\)\s*\{[\s\S]*?navigateTo\(\{ url: '\/pages\/admin\/service-records\/index' \}\)/.test(panelCode) &&
    panelWxml.includes('bindtap="goToServiceRecords"'),
  'entry wired',
);
check(
  'X3 页面使用 DOM 元素 class 与样式表一致（提交/审核/拒绝样式存在）',
  pageWxss.includes('.btn-submit') && pageWxss.includes('.btn-approve') && pageWxss.includes('.btn-reject'),
  'page styles defined',
);
check(
  'X4 页面 json 合法（可解析）',
  (() => {
    try {
      JSON.parse(pageJson);
      return true;
    } catch {
      return false;
    }
  })(),
  'valid page json',
);

// ============================ U：P35-C3B 能力 / 身份安全投影契约 ============================
//
// P35-C3B 取代此前的 legacy-role 推断：
//   - P35 权限【不再】由前端 legacy role（super_admin/admin/auditor）推断；
//     改为消费后端 capabilities 投影（值来自真实 service.record.adjust / service.record.review 求值）。
//   - 申请历史展示 requester 安全身份（public_id + display_name），绝不回退 numeric id。
//
// 后端真实（role → capability）矩阵由 tests/p35_c2_service_time_adjustment_approval.mjs 场景 AL
// （D/E/F/G/H/I/J + N/O）以真实 app + D1 证明；本文件负责前端「是否已正确消费 / 是否已不再自行判定」。

// ---- K/L：前端改为消费后端 capability 布尔（不再自行推断） ----

check(
  'K1 页面不再按 legacy role 推断 P35 审核能力（computeCanReview 已移除）',
  !/computeCanReview/.test(pageCode),
  'no legacy-role canReview inference',
);
check(
  'K2 页面不再按 legacy role 推断 P35 提交能力（SUBMIT_ADJUSTMENT_ROLES 已移除）',
  !/SUBMIT_ADJUSTMENT_ROLES/.test(pageCode),
  'no legacy-role canRequest inference',
);
check(
  'L1 canReview / canRequest 直接取自后端 capabilities 布尔',
  /caps\.can_review_adjustment/.test(pageCode) &&
    /caps\.can_submit_adjustment/.test(pageCode) &&
    pageCode.includes('canReview') &&
    pageCode.includes('canRequest'),
  'capability-driven flags',
);
check(
  'L2 adminApi 镜像后端 capabilities DTO（can_submit_adjustment / can_review_adjustment）',
  /export interface AdjustmentCapabilities \{[\s\S]*?can_submit_adjustment:\s*boolean;[\s\S]*?can_review_adjustment:\s*boolean;/.test(
    adminApiSrc,
  ),
  'capabilities DTO mirrored',
);
check(
  'L3 申请历史 wrapper 返回 capabilities（listServiceRecordAdjustments）',
  /listServiceRecordAdjustments\([\s\S]{0,400}?capabilities/.test(adminApiCode),
  'history wrapper returns capabilities',
);

// ---- F/G/H/I/J：前端不持有任何角色→P35 能力映射（真值一律由后端裁决） ----

const v2RoleTokens = [
  'platform_super_admin',
  'platform_operator',
  'team_owner',
  'team_admin',
  'team_auditor',
  'volunteer',
];
const v2HitsInPage = v2RoleTokens.filter((t) => pageCode.includes(t));
check(
  'F/G/H/I/J 页面不含任何 v2 RBAC 角色码（team_auditor/team_admin/team_owner/platform_operator/volunteer 一律由后端裁决）',
  v2HitsInPage.length === 0,
  v2HitsInPage.length ? `命中: ${v2HitsInPage.join(', ')}` : 'no v2 role codes in page',
);
check(
  'U3 console-entry role set 仅用于进门判定（checkLogin），不参与 P35 能力',
  /CONSOLE_ENTRY_ROLES\.indexOf\(readAdminRole\(\)\)\s*<\s*0/.test(pageCode) &&
    /const CONSOLE_ENTRY_ROLES: string\[\] = \[/.test(pageCode),
  'entry gate only',
);
check(
  'U4 页面无 volunteer 角色门（volunteer 非前端角色；非管理台角色由进门判定拦截）',
  !/['"]volunteer['"]/.test(pageCode),
  'no volunteer role literal',
);

// ---- A/B/C/M：requester 安全身份投影（安全展示，禁 numeric 回退） ----

const adjDtoBlock = (adminApiSrc.match(/export interface AdjustmentRequestView \{[\s\S]*?\n\}/) || [''])[0];
check(
  'A adminApi 镜像后端 requester 安全身份（public_id + display_name）',
  /requester:\s*\{\s*public_id:\s*string;\s*display_name:\s*string \| null\s*\}\s*\|\s*null/.test(adjDtoBlock),
  'requester DTO safe identity',
);
check(
  'B 页面 requester_label 用 display_name 优先、public_id 回退（绝不回退 numeric id）',
  /requester_label:[\s\S]{0,140}display_name\s*\|\|\s*a\.requester\.public_id/.test(pageCode),
  'safe identity fallback',
);
check(
  'C 页面与 WXML 均不渲染 numeric requester_id / reviewer_id',
  !/\b(requester_id|reviewer_id)\b/.test(pageCode) && !/\b(requester_id|reviewer_id)\b/.test(pageWxml),
  'no numeric actor id',
);
check(
  'M WXML 历史行 + 待审核区渲染「申请人」安全身份（requester_label）',
  pageWxml.includes('申请人：{{item.requester_label}}') &&
    pageWxml.includes('申请人：{{pendingAdjustment.requester_label}}'),
  'requester rendered safely',
);
check(
  'M2 WXML 不再声称"不展示申请人"（旧限制已解除）',
  !pageWxml.includes('不展示“申请人”') && !pageWxml.includes('不展示"申请人"'),
  'stale limitation note removed',
);

// ============================ 汇总 ============================

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);

console.log('\n===== P35-C3 Service Time Adjustment Frontend Contract =====');
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
}
console.log(`\n结果: ${passed}/${results.length} PASS`);

if (failed.length) {
  console.log('\n失败项:');
  for (const f of failed) console.log(`  - ${f.name} ${f.detail}`);
  process.exit(1);
}
console.log('\nP35-C3 FRONTEND CONTRACT = PASS');
