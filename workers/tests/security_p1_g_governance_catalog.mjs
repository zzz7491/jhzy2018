// security_p1_g_governance_catalog.mjs
// P1-G functional acceptance — Volunteer UGC governance catalog reconciliation.
//
// Scope (STRICT): static verification only.
//   - No seed execution, no migration execution, no remote D1 / production access.
//   - Reads the catalog JSON + migration 0026 file from disk and asserts invariants.
//
// Pass criteria map to the P1-G post-change / reseed-safety contracts.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const catalogPath = join(repoRoot, 'workers', 'scripts', 'permission-catalog.json');
const migration0026Path = join(repoRoot, 'workers', 'migrations', '0026_p33_r2a_readonly_lockdown.sql');

let failures = [];
function check(name, cond) {
  if (!cond) failures.push(name);
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
}

const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const m26 = readFileSync(migration0026Path, 'utf8');

const defs = new Set(catalog.permissions.map((p) => p.code));
const vol = catalog.rolePermissions.volunteer || [];
const psa = catalog.rolePermissions.platform_super_admin || [];

// A. permission definitions still exist (not deleted)
check('A1 def content.article.self.create exists', defs.has('content.article.self.create'));
check('A2 def content.article.self.update exists', defs.has('content.article.self.update'));

// B. volunteer rolePermissions no longer contains the two self-content perms
check('B1 volunteer NOT bound to content.article.self.create', !vol.includes('content.article.self.create'));
check('B2 volunteer NOT bound to content.article.self.update', !vol.includes('content.article.self.update'));

// C. at least one legitimate admin role still retains the permission (definitions not mistaken for role bindings)
check('C1 platform_super_admin still bound to content.article.self.create', psa.includes('content.article.self.create'));
check('C2 platform_super_admin still bound to content.article.self.update', psa.includes('content.article.self.update'));

// D. reseed-intent: catalog will NOT re-grant volunteer self-content if used as SSOT
check('D1 reseed-intent: volunteer lacks self.create', !vol.includes('content.article.self.create'));
check('D2 reseed-intent: volunteer lacks self.update', !vol.includes('content.article.self.update'));

// E. migration 0026 still carries the volunteer revoke semantics (untouched this round)
const m26RevokesVolunteerSelf =
  /DELETE\s+FROM\s+role_permissions[\s\S]*?roles\s+WHERE\s+code\s*=\s*'volunteer'/i.test(m26) &&
  /content\.article\.self\.create/.test(m26) &&
  /content\.article\.self\.update/.test(m26);
check('E1 0026 still revokes volunteer content.article.self.create/update', m26RevokesVolunteerSelf);

// F. (implicit) this test performs no seed / migration / remote DB operation — asserted by absence of such calls.

// Informational
console.log('');
console.log('INFO permissionCount=' + catalog.permissions.length);
let rpTotal = 0;
for (const k in catalog.rolePermissions) rpTotal += catalog.rolePermissions[k].length;
console.log('INFO rolePermissionTotal=' + rpTotal);
console.log('INFO meta.rolePermissionsRowCount=' + catalog.meta.rolePermissionsRowCount);

console.log('');
if (failures.length) {
  console.log('TEST_RESULT=FAIL (' + failures.length + ' failure(s): ' + failures.join('; ') + ')');
  process.exit(1);
} else {
  console.log('TEST_RESULT=PASS');
  process.exit(0);
}
