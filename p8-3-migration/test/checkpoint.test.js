import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { MemoryCheckpoint, FileCheckpoint } from '../src/checkpoint.js';

// Every test creates an isolated temp dir under the OS temp root and removes it
// in a finally block. NEVER touches any production path.
const cpFile = (dir) => path.join(dir, 'checkpoint.json');

// ---------------------------------------------------------------------------
// DEFECT-WP3-01 regression guard
// ---------------------------------------------------------------------------

test('DEFECT-WP3-01: FileCheckpoint._fs() must remain callable (no own-property shadowing)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p83-checkpoint-'));
  try {
    const cp = new FileCheckpoint(cpFile(dir));
    assert.equal(typeof cp._fs, 'function', '_fs must be a callable prototype method');
    assert.ok(
      !Object.prototype.hasOwnProperty.call(cp, '_fs'),
      'constructor must NOT define an own property named _fs (it shadowed the method)'
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(cp, '_fsModule'),
      'cached module handle must live on _fsModule'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DEFECT-WP3-01: full FileCheckpoint lifecycle must not throw TypeError', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p83-checkpoint-'));
  try {
    const cp = new FileCheckpoint(cpFile(dir));
    // Before the fix each of these threw: TypeError: this._fs is not a function
    const next = await cp.save({ doneTables: ['api.users'] });
    assert.deepEqual(next, { doneTables: ['api.users'] });
    const loaded = await cp.load();
    assert.deepEqual(loaded, { doneTables: ['api.users'] });
    await cp.reset();
    assert.deepEqual(await cp.load(), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Required coverage
// ---------------------------------------------------------------------------

test('FileCheckpoint.load(): missing file returns initial empty state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p83-checkpoint-'));
  try {
    const cp = new FileCheckpoint(cpFile(dir));
    assert.equal(fs.existsSync(cpFile(dir)), false, 'precondition: file must not exist');
    const state = await cp.load();
    assert.deepEqual(state, {}, 'missing checkpoint file must yield {}');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FileCheckpoint.save() → load(): persisted state round-trips', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p83-checkpoint-'));
  try {
    const cp = new FileCheckpoint(cpFile(dir));
    await cp.save({ doneTables: ['api.users'] });
    await cp.save({ lastBatch: 'B1' });

    const state = await cp.load();
    assert.deepEqual(state, { doneTables: ['api.users'], lastBatch: 'B1' }, 'save must merge patches');

    const raw = fs.readFileSync(cpFile(dir), 'utf8');
    assert.deepEqual(JSON.parse(raw), { doneTables: ['api.users'], lastBatch: 'B1' }, 'file content must match');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FileCheckpoint.reset(): clears persisted state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p83-checkpoint-'));
  try {
    const cp = new FileCheckpoint(cpFile(dir));
    await cp.save({ doneTables: ['api.users', 'api.volunteers'], lastBatch: 'B2' });
    assert.notDeepEqual(await cp.load(), {}, 'precondition: state must be non-empty before reset');

    await cp.reset();
    assert.deepEqual(await cp.load(), {}, 'after reset the state must be empty');
    assert.equal(fs.readFileSync(cpFile(dir), 'utf8'), '{}', 'reset must write {} to disk');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Cross-instance persistence: save → new FileCheckpoint → load', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p83-checkpoint-'));
  try {
    const file = cpFile(dir);
    const a = new FileCheckpoint(file);
    await a.save({ doneTables: ['api.users'], lastBatch: 'B3', startedAt: '2026-09-18T00:00:00Z' });

    // A brand-new instance over the same path (simulates a resumed run).
    const b = new FileCheckpoint(file);
    const state = await b.load();
    assert.deepEqual(state, {
      doneTables: ['api.users'],
      lastBatch: 'B3',
      startedAt: '2026-09-18T00:00:00Z',
    }, 'a new instance must read back state written by the previous one');

    // And it can continue appending.
    await b.save({ lastBatch: 'B4' });
    assert.deepEqual(await new FileCheckpoint(file).load(), {
      doneTables: ['api.users'],
      lastBatch: 'B4',
      startedAt: '2026-09-18T00:00:00Z',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// MemoryCheckpoint regression (behaviour must be unchanged)
// ---------------------------------------------------------------------------

test('MemoryCheckpoint regression: load/save/reset behaviour unchanged', async () => {
  const cp = new MemoryCheckpoint();
  assert.deepEqual(await cp.load(), {}, 'initial empty');

  await cp.save({ doneTables: ['api.users'] });
  await cp.save({ lastBatch: 'B1' });
  assert.deepEqual(await cp.load(), { doneTables: ['api.users'], lastBatch: 'B1' }, 'merge patches');

  await cp.reset();
  assert.deepEqual(await cp.load(), {}, 'reset clears');
  assert.deepEqual(cp.state, {}, 'state field still exposed (public API unchanged)');
});

test('Public API surface unchanged: load/save/reset exist on both classes', () => {
  for (const Ctor of [MemoryCheckpoint, FileCheckpoint]) {
    const proto = Ctor.prototype;
    assert.equal(typeof proto.load, 'function', `${Ctor.name}.load`);
    assert.equal(typeof proto.save, 'function', `${Ctor.name}.save`);
    assert.equal(typeof proto.reset, 'function', `${Ctor.name}.reset`);
  }
});
