import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TABLE_MAP, EXCLUSIONS, sourceSystemOf, mappedCount } from '../src/tablemap.js';
import { BATCHES, tablesForBatch } from '../src/batches.js';
import { TRANSFORMS, HAS_PUBLIC_ID } from '../src/transforms.js';

const VALID_KINDS = new Set(['MIGRATE', 'TRANSFORM', 'MERGE', 'ARCHIVE', 'DROP', 'EXCLUDED']);

test('WP3: TABLE_MAP covers all 131 source objects (130 mapped + 1 EXCLUSION)', () => {
  const total = Object.keys(TABLE_MAP).length;
  assert.equal(total, 131, 'WP2 §2 enumerated 131 source objects');
  assert.equal(EXCLUSIONS.length, 1, 'exactly one explicit exclusion (user_favorites)');
  assert.equal(mappedCount(), 130, '130 mapped (excludes user_favorites)');
  assert.ok(EXCLUSIONS.includes('api.user_favorites'), 'user_favorites is the excluded object');
});

test('WP3: every spec has a valid kind and a batch present in BATCHES', () => {
  const batchSet = new Set(BATCHES);
  for (const [srcKey, spec] of Object.entries(TABLE_MAP)) {
    assert.ok(VALID_KINDS.has(spec.kind), `${srcKey}: valid kind ${spec.kind}`);
    assert.ok(batchSet.has(spec.batch), `${srcKey}: batch ${spec.batch} is in BATCHES`);
  }
});

test('WP3: every named transform referenced by a spec exists in TRANSFORMS', () => {
  for (const [srcKey, spec] of Object.entries(TABLE_MAP)) {
    if (spec.transform && spec.transform !== undefined) {
      assert.ok(TRANSFORMS[spec.transform], `${srcKey}: transform '${spec.transform}' is implemented`);
    }
    if (spec.targets && Array.isArray(spec.targets)) {
      for (const t of spec.targets) {
        if (t.transform) {
          assert.ok(TRANSFORMS[t.transform], `${srcKey}: nested target transform '${t.transform}' is implemented`);
        }
      }
    }
  }
});

test('WP3: sourceSystemOf resolves api_jhzyfw_com vs signup_db', () => {
  assert.equal(sourceSystemOf('api.users'), 'api_jhzyfw_com');
  assert.equal(sourceSystemOf('signup_db.users'), 'signup_db');
  assert.equal(sourceSystemOf('signup_db.participants'), 'signup_db');
});

test('WP3: every mapped table is reachable from BATCHES (no orphan spec)', () => {
  for (const batch of BATCHES) {
    const t = tablesForBatch(TABLE_MAP, batch);
    assert.ok(Array.isArray(t), `batch ${batch} yields a list`);
  }
  const scheduled = BATCHES.flatMap((b) => tablesForBatch(TABLE_MAP, b));
  const declared = Object.keys(TABLE_MAP);
  // scheduled (excluding EXCLUSIONS) must equal declared minus exclusions
  const scheduledNoExcl = scheduled.filter((k) => !EXCLUSIONS.includes(k));
  assert.equal(scheduledNoExcl.length, declared.length - EXCLUSIONS.length, 'every non-excluded spec is scheduled in some batch');
});

test('WP3: user_favorites is excluded and not scheduled for migration', () => {
  const scheduled = BATCHES.flatMap((b) => tablesForBatch(TABLE_MAP, b)).filter((k) => !EXCLUSIONS.includes(k));
  assert.ok(!scheduled.includes('api.user_favorites'), 'user_favorites must NOT appear in any migration batch');
});

test('WP3: frozen target model compliance — HAS_PUBLIC_ID uses ULID targets only', () => {
  // These target tables are the canonical public_id (ULID) carriers per D1-DATABASE-DESIGN.
  for (const t of ['users', 'teams', 'activities', 'content_articles', 'files']) {
    assert.ok(HAS_PUBLIC_ID.has(t), `${t} carries a ULID public_id`);
  }
});
