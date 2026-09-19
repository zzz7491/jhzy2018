import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRng, makeUlid } from '../src/ulid.js';

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{26}$/;

test('WP3: makeUlid produces a 26-char Crockford base32 value (no I L O U)', () => {
  const id = makeUlid({ time: 1700000000000 });
  assert.match(id, CROCKFORD, '26 chars, Crockford charset');
  assert.equal(id.length, 26);
  assert.ok(!/[ILOU]/.test(id), 'excludes I L O U');
});

test('WP3: makeUlid is deterministic given same time + seeded rng', () => {
  const rng = makeRng(42);
  const a = makeUlid({ time: 1700000000000, rng });
  const b = makeUlid({ time: 1700000000000, rng: makeRng(42) });
  assert.equal(a, b, 'same seed/time -> same ULID');
});

test('WP3: makeUlid varies with time (timestamp prefix)', () => {
  const a = makeUlid({ time: 1700000000000 });
  const b = makeUlid({ time: 1700000000001 });
  // first 10 chars encode time; they differ
  assert.notEqual(a.slice(0, 10), b.slice(0, 10), 'time component differs');
});

test('WP3: makeRng is deterministic and in [0,1)', () => {
  const r1 = makeRng(7);
  const r2 = makeRng(7);
  const seq1 = [r1(), r1(), r1()];
  const seq2 = [r2(), r2(), r2()];
  assert.deepEqual(seq1, seq2, 'same seed -> same sequence');
  for (const v of seq1) {
    assert.ok(v >= 0 && v < 1, 'in range');
  }
});
