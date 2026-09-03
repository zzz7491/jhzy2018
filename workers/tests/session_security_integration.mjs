/**
 * S2-6c-4 集成测试：Session 轮换 / 异常登录检测 / 双密钥 HMAC 过渡（OPEN-6）/ 管理端 CSRF 收尾。
 *
 * 运行前置：wrangler dev --port 8787 + `node tests/fixture.mjs sec`
 * 纪律：不读 Secret 值、不授角色、不改 Schema、不碰 1.0。
 */
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';

let pass = 0;
let fail = 0;
const fails = [];
function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    fails.push(name);
    console.log(`  ❌ ${name} :: ${detail}`);
  }
}

async function req(method, path, { headers = {}, body } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    if (!init.headers['content-type']) init.headers['content-type'] = 'application/json';
  }
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-json */
  }
  return { res, status: res.status, text, body: json, headers: res.headers };
}

const bearer = (t) => ({ authorization: `Bearer ${t}` });
const code = (openid, unionid = '-') => `MOCK_WECHAT_CODE.${openid}.${unionid}`;

function cookieValue(setCookie) {
  const m = /__Host-session=([^;]+)/.exec(setCookie ?? '');
  return m ? `__Host-session=${m[1]}` : null;
}
function maxAgeOf(setCookie) {
  const m = /Max-Age=(\d+)/.exec(setCookie ?? '');
  return m ? Number(m[1]) : null;
}

async function login(openid, unionid = '-', { cookie = false, ua = null } = {}) {
  const headers = {};
  if (ua) headers['user-agent'] = ua;
  const r = await req('POST', `/api/v2/auth/wechat/login${cookie ? '?cookie=1' : ''}`, {
    headers,
    body: { code: code(openid, unionid) },
  });
  const setCookie = r.headers.get('set-cookie');
  return {
    token: r.body?.data?.token,
    cookie: setCookie ? cookieValue(setCookie) : null,
    setCookie,
    status: r.status,
    body: r.body,
  };
}

async function countAbnormal() {
  const r = await req('GET', '/api/v2/__test/security-events/count?type=abnormal_login');
  return r.body?.data?.count ?? -1;
}
async function lastEvents() {
  const r = await req('GET', '/api/v2/__test/security-events');
  return r.body?.data?.items ?? [];
}

// 稳定 public_id（与 fixture IDS 一致）
const VOLA = '01TESTUSERAAAAAAAAAAAAAAAA';
const OWNERA = '01TESTUSERCDDDDDDDDDDDDDDD';
const PREV = '01TESTUSERCPREVKEY00001';

async function main() {
  // ============ A. 异常登录检测 ============
  const baseAnom = await countAbnormal();
  check('A0 初始 abnormal_login 事件基线 = 0', baseAnom === 0, `got ${baseAnom}`);

  const a1 = await login('OPENID_A', 'UNIONID_A', { ua: 'S2-6c-4-Anom-Dev/1.0' });
  check('A1 新设备登录 → 200 且返回 token', a1.status === 200 && typeof a1.token === 'string', `got ${a1.status}`);
  const afterA1 = await countAbnormal();
  check('A2 新设备 → 记 1 条 abnormal_login', afterA1 === baseAnom + 1, `base=${baseAnom} after=${afterA1}`);

  const a2 = await login('OPENID_A', 'UNIONID_A', { ua: 'S2-6c-4-Anom-Dev/1.0' });
  check('A3 同设备再次登录 → 200', a2.status === 200, `got ${a2.status}`);
  const afterA2 = await countAbnormal();
  check('A4 同设备不重复记 abnormal_login（增量 0）', afterA2 === afterA1, `afterA1=${afterA1} afterA2=${afterA2}`);

  const evs = await lastEvents();
  const last = evs[0] ?? {};
  const leak = JSON.stringify(last).includes('OPENID') || JSON.stringify(last).includes('UNIONID') ||
    JSON.stringify(last).includes('token') || JSON.stringify(last).includes('session_key');
  check('A5 审计事件不含 openid/unionid/token/session_key 泄露', leak === false, JSON.stringify(last).slice(0, 160));
  check('A6 异常登录不阻断登录（仍返回 token）', typeof a1.token === 'string' && typeof a2.token === 'string');

  // ============ R. Session 轮换 ============
  const r0 = await login('OPENID_OWNER', '-', { ua: 'S2-6c-4-Rot-Dev/1.0' });
  const T1 = r0.token;
  check('R0 登录 ownerA → token', r0.status === 200 && typeof T1 === 'string');

  const rot = await req('POST', '/api/v2/auth/session/rotate', { headers: bearer(T1) });
  check('R1 轮换有效 token → 200 且返回新 token', rot.status === 200 && typeof rot.body?.data?.token === 'string' && rot.body.data.token !== T1,
    `got ${rot.status} ${JSON.stringify(rot.body)?.slice(0, 120)}`);
  const T2 = rot.body?.data?.token;

  // whoami 仅回显 auth 上下文（恒返回 200），不足以证明失效；改用真正受保护的 /auth/sessions：
  // 无效 token → 401，有效 token → 200（含 items 数组）。
  const oldWho = await req('GET', '/api/v2/auth/sessions', { headers: bearer(T1) });
  check('R2 旧 token 立即失效 → 401', oldWho.status === 401, `got ${oldWho.status}`);
  const newWho = await req('GET', '/api/v2/auth/sessions', { headers: bearer(T2) });
  check('R3 新 token 可用 → 200', newWho.status === 200 && Array.isArray(newWho.body?.data?.items), `got ${newWho.status}`);

  const rotBad = await req('POST', '/api/v2/auth/session/rotate', { headers: bearer('s_invalid_token_value') });
  check('R4 无效 token 轮换 → 401', rotBad.status === 401, `got ${rotBad.status}`);
  const rotNoAuth = await req('POST', '/api/v2/auth/session/rotate', {});
  check('R5 未认证轮换 → 401', rotNoAuth.status === 401, `got ${rotNoAuth.status}`);
  const rotAgain = await req('POST', '/api/v2/auth/session/rotate', { headers: bearer(T2) });
  check('R6 链式轮换（T2→T3）→ 200', rotAgain.status === 200 && typeof rotAgain.body?.data?.token === 'string', `got ${rotAgain.status}`);

  // ============ K. 双密钥 HMAC 过渡（OPEN-6）============
  const k1 = await login('OPENID_PREVKEY', '-', { ua: 'S2-6c-4-PrevDev/1.0' });
  check('K1 上一把密钥哈希的身份 → 仍可登录（secondary 命中）', k1.status === 200 && k1.body?.data?.is_new_user === false,
    `got ${k1.status} ${JSON.stringify(k1.body?.data)?.slice(0, 120)}`);
  check('K2 命中用户 = prev-key 用户（非首登建档）', k1.body?.data?.user?.public_id === PREV, `got ${k1.body?.data?.user?.public_id}`);

  const k3 = await login('OPENID_A', 'UNIONID_A', { ua: 'S2-6c-4-PrimDev/1.0' });
  check('K3 常规用户仍经 primary 命中（unchanged）', k3.status === 200 && k3.body?.data?.user?.public_id === VOLA,
    `got ${k3.body?.data?.user?.public_id}`);
  check('K4 prev-key 用户与 volA 隔离（public_id 不同）', k1.body?.data?.user?.public_id !== VOLA);

  // ============ C. 管理端 CSRF 收尾（Cookie 通道轮换）============
  const c0 = await login('OPENID_A', 'UNIONID_A', { cookie: true, ua: 'S2-6c-4-CSRFDev/1.0' });
  check('C0 管理端登录 → 设置 __Host-session Cookie', c0.cookie != null);
  const c0max = maxAgeOf(c0.setCookie);
  check('C1 Cookie Max-Age = 管理端 12h (43200)', c0max === 43200, `got ${c0max}`);

  const goodOrigin = { origin: 'http://127.0.0.1:8787', 'x-jhzy-csrf': '1' };
  const c1 = await req('POST', '/api/v2/auth/session/rotate?cookie=1', {
    headers: { ...goodOrigin, cookie: c0.cookie },
  });
  check('C2 admin Cookie 轮换带 Origin+Header → 200 + 新 Cookie', c1.status === 200 && c1.headers.get('set-cookie') != null, `got ${c1.status}`);

  const c2 = await req('POST', '/api/v2/auth/session/rotate?cookie=1', {
    headers: { origin: 'http://127.0.0.1:8787', cookie: c0.cookie }, // 无 X-JHZY-CSRF
  });
  check('C3 admin Cookie 轮换无自定义头 → 403', c2.status === 403, `got ${c2.status}`);

  const c3 = await req('POST', '/api/v2/auth/session/rotate?cookie=1', {
    headers: { origin: 'http://evil.example', 'x-jhzy-csrf': '1', cookie: c0.cookie },
  });
  check('C4 admin Cookie 轮换非允许 Origin → 403', c3.status === 403, `got ${c3.status}`);

  // C5：Bearer 通道不受 CSRF 误伤。R6 已把 T2 轮换为 T3，此处必须用【全新】Bearer token（ownerA 重新登录）。
  const c5login = await login('OPENID_OWNER', '-', { ua: 'S2-6c-4-C5Dev/1.0' });
  const c4 = await req('POST', '/api/v2/auth/session/rotate?channel=admin', { headers: bearer(c5login.token) });
  check('C5 Bearer 小程序轮换不被 CSRF 误伤 → 200', c4.status === 200, `got ${c4.status}`);

  // ============ 汇总 ============
  console.log(`\nTOTAL: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('FAILED:', fails.join(' | '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('test crashed:', e);
  process.exit(2);
});
