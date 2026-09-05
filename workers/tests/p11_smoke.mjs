// P11 smoke test：验证 迁移应用 + D1 shim + TS 服务加载 + 一次 SELF occurrence-level 创建 全链路打通。
import { buildP11Db } from './lib/p11db.mjs';
import { generateUlid } from './lib/d1-shim.mjs';
import { ParticipationService } from '../src/services/participation-service';

const { db, raw, fixture, close } = await buildP11Db();

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    throw new Error(msg);
  }
  console.log('PASS:', msg);
}

const auth = { authenticated: true, userId: 1, teamId: 1, role: 'volunteer', roles: [{ role: 'volunteer', scopeTeamId: 1 }] };
const tenant = { scope: 'TEAM_SCOPED', teamId: 1, userId: 1 };
const svc = new ParticipationService({ db, auth, tenant });

// 1) 迁移后权限码应存在
const permCount = raw.prepare("SELECT COUNT(*) AS n FROM permissions WHERE code LIKE 'participation.assignment.%'").get().n;
assert(permCount === 4, `P11 权限码已注入 (n=${permCount})`);

// 2) SELF occurrence-level 创建（无 slot）
const newPid = generateUlid();
const res = await svc.createSelf(fixture.actA1, { occurrence_public_id: fixture.occ1, new_public_id: newPid });
assert(res.replay === false, '首次创建 replay=false');
assert(res.participation.slot_id === null, 'occurrence-level slot_id=null');
assert(res.participation.status === 1, 'status=1 assigned');

// 3) 数据库确有该行
const row = raw.prepare('SELECT * FROM activity_participations WHERE public_id=?').get(newPid);
assert(row && row.status === 1, 'DB 中存在新建参与行');

// 4) 重复 new_public_id 命中 replay
const res2 = await svc.createSelf(fixture.actA1, { occurrence_public_id: fixture.occ1, new_public_id: newPid });
assert(res2.replay === true, '同 new_public_id 命中 replay=true');

console.log('SMOKE OK');
close();
process.exit(0);
