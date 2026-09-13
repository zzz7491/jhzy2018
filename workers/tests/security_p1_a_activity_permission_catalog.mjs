// =============================================================================
// P1-A — Activity Permission Catalog contract test (narrow scope)
// -----------------------------------------------------------------------------
// Strict scope: ONLY activity.activity.submit / activity.activity.review.
//
// This test verifies the catalog reconciliation for P1-A drift:
//   - 2 permission definitions added to workers/scripts/permission-catalog.json
//   - 8 role bindings added, exactly matching migration 0027 effective matrix
//   - volunteer intentionally excluded from both
//   - catalog meta counts recomputed from actual content
//
// It does NOT assert that the GLOBAL role-binding set equals the migrations:
// 3 out-of-scope community volunteer bindings
//   (volunteer|content.comment.create, content.like.create, content.report.create)
// remain catalog-only by design and are verified as UNCHANGED, not "fixed".
// =============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CATALOG_PATH = fileURLToPath(new URL('../scripts/permission-catalog.json', import.meta.url));
const cat = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));

const SUBMIT = 'activity.activity.submit';
const REVIEW = 'activity.activity.review';

const submitBindings = Object.keys(cat.rolePermissions)
  .filter((r) => cat.rolePermissions[r].includes(SUBMIT))
  .sort();
const reviewBindings = Object.keys(cat.rolePermissions)
  .filter((r) => cat.rolePermissions[r].includes(REVIEW))
  .sort();

const expectedSubmit = ['platform_super_admin', 'team_owner', 'team_admin'].sort();
const expectedReview = [
  'platform_super_admin',
  'platform_operator',
  'team_owner',
  'team_admin',
  'team_auditor',
].sort();

const flatten = Object.values(cat.rolePermissions).reduce((a, arr) => a + arr.length, 0);

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log('PASS  ' + name);
  } else {
    console.log('FAIL  ' + name);
    failures += 1;
  }
}

// 1. catalog defines activity.activity.submit
check('1. catalog defines activity.activity.submit', cat.permissions.some((p) => p.code === SUBMIT));

// 2. catalog defines activity.activity.review
check('2. catalog defines activity.activity.review', cat.permissions.some((p) => p.code === REVIEW));

// 3. submit exact bindings
check('3. submit exact bindings = platform_super_admin, team_owner, team_admin',
  JSON.stringify(submitBindings) === JSON.stringify(expectedSubmit));

// 4. review exact bindings
check('4. review exact bindings = platform_super_admin, platform_operator, team_owner, team_admin, team_auditor',
  JSON.stringify(reviewBindings) === JSON.stringify(expectedReview));

// 5. volunteer does NOT have submit
check('5. volunteer does NOT have submit', !cat.rolePermissions.volunteer.includes(SUBMIT));

// 6. volunteer does NOT have review
check('6. volunteer does NOT have review', !cat.rolePermissions.volunteer.includes(REVIEW));

// 7. submit/review have no extra role binding (exact-set match already covers this)
check('7a. submit has no extra role binding', submitBindings.length === expectedSubmit.length);
check('7b. review has no extra role binding', reviewBindings.length === expectedReview.length);

// 8. permissionsRowCount == actual permissions length
check('8. permissionsRowCount == permissions.length',
  cat.meta.permissionsRowCount === cat.permissions.length);

// 9. rolePermissionsRowCount == actual flatten binding count
check('9. rolePermissionsRowCount == flatten binding count',
  cat.meta.rolePermissionsRowCount === flatten);

// 10. catalog permission count == 104
check('10. catalog permission count == 104', cat.permissions.length === 104);

// 11. catalog role binding count == 295
check('11. catalog role binding count == 295', flatten === 295);

// Community out-of-scope bindings must remain UNCHANGED (present, not touched)
const community = ['content.comment.create', 'content.like.create', 'content.report.create'];
check('12. community volunteer bindings present (unchanged)',
  community.every((c) => cat.rolePermissions.volunteer.includes(c)));

if (failures > 0) {
  console.log('\nTEST RESULT: FAIL (' + failures + ' failure(s))');
  process.exit(1);
} else {
  console.log('\nTEST RESULT: PASS');
  process.exit(0);
}
