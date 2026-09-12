// =============================================================================
// N0-E5A-R1 — Activity Address Edit Gap（静态装配验证）
//
// 背景：miniprogram/pages/admin/activity-abc 的编辑弹窗存在「活动地点」输入，
//   但此前 load 恒为空串、save 不发送 → 悬空 location input（EDIT_ADDRESS_UX_GAP = YES）。
// N0-E5A-R1 以极小改动接入正式 address：
//   - loadActivityDetail：location 回填 a.address
//   - toListView：list location 投影 a.address
//   - saveActivityEdit：patch 发送 address（空 → null）
//   - adminApi：ActivityRow / ActivityScalarUpdate 增加 address 类型
//
// 本套件为【静态装配测试】（前端页面无 node 运行时 harness）：
//   读取真实源文件，断言 address wiring 已建立且未引入 legacy PHP / 地图 / GPS 依赖。
//
// 运行：node tests/n0e5a_r1_address_edit_wiring.mjs（在 workers/ 目录）
// =============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO = fileURLToPath(new URL('../..', import.meta.url)); // miniprogram/
const ABC = join(REPO, 'miniprogram/pages/admin/activity-abc/index.ts');
const ADMIN_API = join(REPO, 'miniprogram/utils/adminApi.ts');

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

const abc = readFileSync(ABC, 'utf8');
const adminApi = readFileSync(ADMIN_API, 'utf8');

// loadActivityDetail：editForm.location 回填 a.address
check('loadActivityDetail 回填 location = a.address（不再恒空串）',
  /location:\s*a\.address\s*\|\|\s*''/.test(abc));

// toListView：list 投影使用 a.address
const toListIdx = abc.indexOf('toListView(');
const loadDetailIdx = abc.indexOf('loadActivityDetail(');
check('toListView 与 loadActivityDetail 均已接入 a.address',
  (abc.match(/location:\s*a\.address\s*\|\|\s*''/g) || []).length >= 2,
  `occurrences=${(abc.match(/location:\s*a\.address\s*\|\|\s*''/g) || []).length}`);

// saveActivityEdit：patch 发送 address
check('saveActivityEdit patch 发送 address',
  /address:\s*form\.location\s*&&\s*form\.location\.trim\(\)\s*\?\s*form\.location\.trim\(\)\s*:\s*null/.test(abc));

// adminApi 类型
check('adminApi.ActivityRow 含 address',
  /interface ActivityRow\s*\{[\s\S]*?address\??:\s*string\s*\|\s*null/.test(adminApi));
check('adminApi.ActivityScalarUpdate 含 address',
  /interface ActivityScalarUpdate\s*\{[\s\S]*?address\??:\s*string\s*\|\s*null/.test(adminApi));

// 作用域纪律：未引入 legacy PHP / 地图 / GPS / service point
check('未引入 legacy PHP 调用（无 .php 端点）', !/\.php\b|request\.js/.test(abc));
check('未引入地图 / GPS / service point 依赖', !/chooseLocation|getLocation|latitude|longitude|service_point|latitude/i.test(abc));

// 编辑补丁未扩大 activity editor contract（仍只发送既有标量字段集合）
check('patch 仍为标量字段集合（title/summary/address/start_time/end_time/quota）',
  /title:[\s\S]{0,200}summary:[\s\S]{0,200}address:[\s\S]{0,200}start_time:[\s\S]{0,200}end_time:[\s\S]{0,200}quota:/.test(abc));

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n==============================');
console.log(`N0-E5A-R1 RESULT: ${passed}/${results.length} PASS`);
if (failed) {
  console.log('FAILED:');
  for (const r of results.filter((x) => !x.pass)) console.log(`  - ${r.name} ${r.detail}`);
}
console.log(failed ? '=== N0-E5A-R1 = BLOCKED ===' : '=== N0-E5A-R1 = PASS ===');
process.exit(failed ? 1 : 0);
