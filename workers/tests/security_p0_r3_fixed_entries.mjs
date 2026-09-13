// =============================================================================
// SECURITY P0-1 R3+R4 — FIXED ENTRY (学习培训 / 我的团队) + LEGACY DASHBOARD 移除
// （source-contract，静态）
//
// 范围：
//  R3：在个人中心新增两个固定入口（无资格门/团队门/角色门）。
//  R4：彻底移除 P0-1 暴露路径
//      mine page → loadDashboardModules() → user_dashboard.php?token=<legacy token>
//      （dashboardModules 数据字段 / loadDashboardModules() / goToDynamicPage() /
//        quick-actions WXML 区块 / logout 复位字段 全部删除）。
//
// 本轮【不】清理 mine.scss 中的 dead CSS（安全修复优先，避免 selector 回归面）。
// 策略：纯源码契约扫描，不构建、不联网、不触远端。
// 运行（workers/ 目录）：node tests/security_p0_r3_fixed_entries.mjs
// =============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url)); // repo root
const F_WXML = ROOT + 'miniprogram/pages/mine/mine.wxml';
const F_TS = ROOT + 'miniprogram/pages/mine/mine.ts';
const F_SCSS = ROOT + 'miniprogram/pages/mine/mine.scss';
const F_APPJSON = ROOT + 'miniprogram/app.json';

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

const wxml = readFileSync(F_WXML, 'utf8');
const ts = readFileSync(F_TS, 'utf8');
const scss = readFileSync(F_SCSS, 'utf8');
const appJson = readFileSync(F_APPJSON, 'utf8').replace(/^\uFEFF/, '');

// 提取某个 handler 的源码块（从 `name(...) {` 到匹配的收尾 `},`）。
function handlerBody(src, name) {
  const re = new RegExp('\\n\\s{2}' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(src);
  if (!m) return null;
  const start = m.index + m[0].length;
  let depth = 1;
  let i = start;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return src.slice(start, i);
}

// ---------- A. WXML 固定入口存在 ----------
check('wxml: 我的团队 entry present (bindtap="goToTeams")', /class="message-entry"\s+bindtap="goToTeams"/.test(wxml));
check('wxml: 学习培训 entry present (bindtap="goToTraining")', /class="message-entry"\s+bindtap="goToTraining"/.test(wxml));
check('wxml: 我的团队 label present', wxml.includes('>我的团队<'));
check('wxml: 学习培训 label present', wxml.includes('>学习培训<'));
check('wxml: reuses existing .message-entry pattern', (wxml.match(/class="message-entry"/g) || []).length >= 7);

// ---------- B/C/D. TS handler + 导航方法 + 无门禁 ----------
const teamBody = handlerBody(ts, 'goToTeams');
const trainBody = handlerBody(ts, 'goToTraining');

check('ts: goToTeams() defined', !!teamBody);
check('ts: goToTraining() defined', !!trainBody);

check('ts: goToTeams → /pages/teams/teams (navigateTo)', !!teamBody && /wx\.navigateTo\(\{\s*url:\s*'\/pages\/teams\/teams'\s*\}\)/.test(teamBody.replace(/\s+/g, ' ').replace(/\(\s*\{/, '({ ').replace(/\s*\}\)/, ' })')));
check('ts: goToTraining → /pages/training/training (navigateTo)', !!trainBody && /wx\.navigateTo\(\{\s*url:\s*'\/pages\/training\/training'\s*\}\)/.test(trainBody.replace(/\s+/g, ' ').replace(/\(\s*\{/, '({ ').replace(/\s*\}\)/, ' })')));
check('ts: both use navigateTo (not switchTab/redirectTo)', !!teamBody && !!trainBody && teamBody.includes('wx.navigateTo') && trainBody.includes('wx.navigateTo') && !teamBody.includes('switchTab') && !trainBody.includes('switchTab') && !teamBody.includes('redirectTo') && !trainBody.includes('redirectTo'));
check('ts: login guard reuses showLoginModal()', !!teamBody && !!trainBody && teamBody.includes('showLoginModal()') && trainBody.includes('showLoginModal()'));

// 无门禁：两个 handler 内不得出现 资格/团队/角色 相关门禁标识。
const gateRe = /qualified|qualification|volunteerQualification|examEligible|hasTeamContext|activeTeamPublicId|TEAM_SCOPE_REQUIRED|adminInfo|canCreateTeam|role\s*===|permission/i;
check('ts: goToTeams has no qualification/team/role gate', !!teamBody && !gateRe.test(teamBody));
check('ts: goToTraining has no qualification/team/role gate', !!trainBody && !gateRe.test(trainBody));
check('ts: no qualification/team gate in either handler body', !!teamBody && !!trainBody && !gateRe.test(teamBody + trainBody));

// ---------- E. (R4) legacy dashboard token-in-query 路径已彻底移除 ----------
check('ts: user_dashboard.php removed', !ts.includes('user_dashboard.php'));
check('ts: loadDashboardModules removed', !ts.includes('loadDashboardModules'));
check('ts: dashboardModules removed', !ts.includes('dashboardModules'));
check('ts: goToDynamicPage removed', !ts.includes('goToDynamicPage'));
check('ts: legacy token-in-query dashboard path removed', !(/user_dashboard\.php\?token=/).test(ts));
check('wxml: dashboardModules binding removed', !wxml.includes('dashboardModules'));
check('wxml: goToDynamicPage binding removed', !wxml.includes('goToDynamicPage'));
check('wxml: legacy quick-actions dynamic block removed', !wxml.includes('quick-actions') && !wxml.includes('快捷功能'));
check('wxml: legacy data-url dynamic binding removed', !wxml.includes('data-url'));
check('ts: R3 goToTeams preserved', ts.includes('goToTeams'));
check('ts: R3 goToTraining preserved', ts.includes('goToTraining'));
check('wxml: R3 我的团队 entry preserved', wxml.includes('>我的团队<'));
check('wxml: R3 学习培训 entry preserved', wxml.includes('>学习培训<'));

// ---------- F. mine.scss 未参与本轮修改（dead CSS 有意保留） ----------
check('scss: .message-entry style present (reused, no new style needed)', /\.message-entry\b/.test(scss));
check('scss: legacy .quick-actions style intentionally retained (NOT cleaned this round)', /\.quick-actions\b/.test(scss));

// ---------- G. 目标页仍在 app.json 注册 ----------
let pages = [];
try { pages = JSON.parse(appJson).pages || []; } catch (e) { /* noop */ }
check('app.json: pages/training/training registered', pages.includes('pages/training/training'));
check('app.json: pages/teams/teams registered', pages.includes('pages/teams/teams'));

// ---------- summary ----------
const passed = results.filter((r) => r.pass).length;
console.log(`\n==== SECURITY P0-1 R3+R4 FIXED ENTRIES / LEGACY DASHBOARD REMOVAL ====`);
console.log(`${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
