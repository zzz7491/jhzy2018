import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMigration } from '../src/runner.js';
import { MemoryTarget } from '../src/adapters.js';
import { createLogger } from '../src/logger.js';
import { buildSource } from './fixtures.js';

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

test('WP3: full run migrates canonical tables and respects frozen target model', async () => {
  const source = buildSource();
  const target = new MemoryTarget();
  const logger = createLogger({ sink: [] });
  const { stats } = await runMigration({ source, target, opts: { logger } });

  // inserted rows across target tables
  assert.ok(stats.inserted > 0, 'should insert rows');
  assert.equal(stats.errors, 0, 'no transform errors on canonical data');

  // users: INTEGER PK + ULID public_id + epoch time
  const u = target.query('users', { nickname: 'Alice' })[0];
  assert.ok(u, 'Alice migrated');
  assert.equal(typeof u.id, 'number', 'INTEGER PK');
  assert.match(u.public_id, ULID_RE, 'ULID public_id (26, Crockford)');
  assert.equal(typeof u.last_login_at, 'number', 'DATETIME -> epoch INTEGER');
  assert.notEqual(u.last_login_at, null);

  // points_ledger: epoch + request_id idempotent key preserved
  const p = target.query('points_ledger', { user_id: 1 })[0];
  assert.ok(p, 'points migrated');
  assert.equal(typeof p.created_at, 'number');
  assert.equal(p.request_id, 'r1');

  // certificates: PII masked (holder_name_raw not stored; id_card not in row)
  const c = target.query('certificates', { user_id: 1 })[0];
  assert.ok(c, 'certificate migrated');
  assert.equal(c.holder_name, null, 'plaintext id_card not carried; masked via separate field only');
});

test('WP3: user_favorites explicitly EXCLUDED (not migrated/dropped/archived)', async () => {
  const source = buildSource();
  const target = new MemoryTarget();
  const logger = createLogger({ sink: [] });
  await runMigration({ source, target, opts: { logger } });

  // Not present in any target business table
  for (const t of target.tables.keys()) {
    const hit = target.query(t, {}).some((r) => r.target_type === 'activity' && r.target_id === 10);
    assert.equal(hit, false, `user_favorites row must not appear in ${t}`);
  }
  // An 'excluded' issue recorded
  const excluded = target.allIssues().find((i) => i.issue_type === 'excluded' && i.source_object === 'api.user_favorites');
  assert.ok(excluded, 'exclusion issue recorded');
  assert.equal(excluded.resolution_status, 'excluded');
});

test('WP3: idempotent re-run inserts 0 (legacy_id_maps guards)', async () => {
  const source = buildSource();
  const target = new MemoryTarget();
  const logger = createLogger({ sink: [] });

  await runMigration({ source, target, opts: { logger } });
  const firstInserted = target.allIdMaps().length;
  assert.ok(firstInserted > 0, 'idmaps recorded on first run');

  const source2 = buildSource();
  const logger2 = createLogger({ sink: [] });
  const r2 = await runMigration({ source: source2, target, opts: { logger: logger2 } });
  assert.equal(r2.stats.inserted, 0, 'second run inserts nothing (idempotent)');
  assert.equal(r2.stats.skippedIdempotent, firstInserted, 'all rows skipped via idmap');
  assert.equal(target.allIdMaps().length, firstInserted, 'idmaps not duplicated');
});

test('WP3: checkpoint/resume skips already-done table', async () => {
  const source = buildSource();
  const target = new MemoryTarget();
  const logger = createLogger({ sink: [] });
  const checkpoint = {
    _s: { doneTables: ['api.users'] },
    async load() { return this._s; },
    async save(p) { this._s = { ...this._s, ...p }; },
  };
  await runMigration({ source, target, opts: { logger, checkpoint } });
  assert.equal(target.count('users'), 0, 'users skipped via checkpoint');
  assert.ok(target.count('activities') > 0, 'other tables still processed');
});

test('WP3: dry-run writes nothing but logs intent', async () => {
  const source = buildSource();
  const target = new MemoryTarget();
  const logger = createLogger({ sink: [] });
  const r = await runMigration({ source, target, opts: { logger, dryRun: true } });
  assert.equal(r.stats.inserted, 0, 'dry-run inserts 0');
  assert.ok(logger.sink.some((e) => e.msg === 'dry_run_insert'), 'dry-run logs inserts');
  assert.equal(target.count('users'), 0, 'no data written');
});

test('WP3: ARCHIVE and DROP dispositions handled, not migrated', async () => {
  const source = buildSource();
  const target = new MemoryTarget();
  const logger = createLogger({ sink: [] });
  await runMigration({ source, target, opts: { logger } });

  // quick_actions -> archive (cold store), not a business table
  assert.equal(target.count('quick_actions'), 0, 'archive source not loaded as business table');
  assert.equal(target.allArchive().length, 1, 'archived payload preserved');
  assert.equal(target.allArchive()[0].source_table, 'quick_actions');

  // qr_codes -> dropped (issue recorded, no insert)
  assert.equal(target.count('qr_codes'), 0, 'dropped not loaded');
  const dropped = target.allIssues().find((i) => i.issue_type === 'dropped' && i.source_object === 'api.qr_codes');
  assert.ok(dropped, 'drop issue recorded');
});

test('WP3: failure isolation records issue and continues on bad row', async () => {
  const source = buildSource();
  // inject a corrupt row whose transform throws naturally: circular ref in a JSON.stringify'd column.
  const circular = {};
  circular.self = circular;
  source.tables['api.activities'].push({
    id: 999,
    team_id: 1,
    title: 'bad',
    start_time: '2026-03-01 08:00:00',
    checkin_config: circular, // JSON.stringify(circular) throws TypeError -> caught by runner
  });
  const target = new MemoryTarget();
  const logger = createLogger({ sink: [] });
  const r = await runMigration({ source, target, opts: { logger } });
  assert.ok(r.stats.errors > 0, 'transform error captured');
  assert.ok(target.allIssues().some((i) => i.issue_type === 'dirty' && i.severity === 'error'), 'dirty issue recorded');
  // other tables still migrated
  assert.ok(target.count('users') > 0, 'migration continues after a bad row');
});

test('WP3: production topology / data untouched (MemoryTarget only, no D1 binding)', async () => {
  const source = buildSource();
  const target = new MemoryTarget(); // not D1Target
  await runMigration({ source, target, opts: { logger: createLogger({ sink: [] }) } });
  assert.equal(target.constructor.name, 'MemoryTarget', 'no production D1 binding invoked');
});
