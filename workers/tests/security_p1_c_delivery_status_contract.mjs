// SECURITY P1-C — DeliveryStatus union contract test (narrow, deterministic).
//
// Scope: verify the TypeScript `DeliveryStatus` union in
//   workers/src/repository/notification-delivery.ts
// exactly matches the effective DB + runtime contract, which includes 'RESERVED'.
//
// Discipline:
//   - read-only: parses the source file, never mutates runtime / DB / D1.
//   - no network, no D1, no external dependency.
//   - deterministic assertion of exact union membership.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET = join(__dirname, '..', 'src', 'repository', 'notification-delivery.ts');

const EXPECTED = [
  'RESERVED',
  'DELIVERED',
  'NOT_ELIGIBLE',
  'INVALID_PAYLOAD',
  'PROVIDER_REJECTED',
  'PROVIDER_ERROR',
  'NETWORK_ERROR',
];

let failures = 0;
function check(cond, label, detail = '') {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`);
}

// 1. Read target source.
let src;
try {
  src = readFileSync(TARGET, 'utf8');
  check(true, 'read_target_file', TARGET);
} catch (e) {
  check(false, 'read_target_file', String(e));
  process.exit(1);
}

// 2. Locate the DeliveryStatus union block.
const declRe = /export\s+type\s+DeliveryStatus\s*=\s*([\s\S]*?);/;
const m = src.match(declRe);
check(!!m, 'locate_DeliveryStatus_union');
if (!m) {
  process.exit(1);
}

// 3. Extract single-quoted members from the union block.
const block = m[1];
const members = [...block.matchAll(/'([^']+)'/g)].map((x) => x[1]);
check(members.length > 0, 'extract_union_members', `count=${members.length}`);

// 4. Assert exact membership (set equality, order-independent).
const actualSet = new Set(members);
const expectedSet = new Set(EXPECTED);

const missing = EXPECTED.filter((x) => !actualSet.has(x));
const extra = members.filter((x) => !expectedSet.has(x));

check(missing.length === 0, 'no_missing_members', missing.length ? `missing=${missing.join(',')}` : 'all expected present');
check(extra.length === 0, 'no_extra_members', extra.length ? `extra=${extra.join(',')}` : 'no extra members');
check(members.length === EXPECTED.length, 'exact_count', `actual=${members.length} expected=${EXPECTED.length}`);

// 5. TS_HAS_RESERVED.
const tsHasReserved = actualSet.has('RESERVED');
check(tsHasReserved, 'TS_HAS_RESERVED', tsHasReserved ? 'YES' : 'NO');

// 6. Exact match verdict.
const exactMatch = missing.length === 0 && extra.length === 0 && members.length === EXPECTED.length;
check(exactMatch, 'DELIVERY_STATUS_EXACT_MATCH', exactMatch ? 'YES' : 'NO');

console.log('---');
console.log('DELIVERY_STATUS_MEMBERS=' + JSON.stringify(members));
console.log('TS_HAS_RESERVED=' + (tsHasReserved ? 'YES' : 'NO'));
console.log('DELIVERY_STATUS_EXACT_MATCH=' + (exactMatch ? 'YES' : 'NO'));

process.exit(failures === 0 ? 0 : 1);
