/**
 * P0-A Tencent Result 码 → 系统状态 映射 确定性单元测试。
 *
 * 运行（先编译 Provider 再跑测试）：
 *   cd workers
 *   rm -rf node_modules/.cache/tb
 *   node_modules/.bin/tsc src/providers/identity/tencent.ts src/providers/identity/types.ts \
 *     --outDir node_modules/.cache/tb --module esnext --target es2022 --moduleResolution bundler --skipLibCheck
 *   printf '{"type":"module"}' > node_modules/.cache/tb/package.json
 *   node tests/tencent_result_mapping.test.mjs
 *
 * 不依赖 wrangler dev / 不发起任何真实腾讯云请求 / 无收费。
 * 直接导入编译后的真实实现（mapTencentResult 纯函数）。
 */

import { mapTencentResult } from '../node_modules/.cache/tb/tencent.js';

const RID = 'req-abc-123';

/** @type {{result: string|undefined, expectResult: string, expectCode: string|null}[]} */
const cases = [
  { result: '0', expectResult: 'VERIFIED', expectCode: null },
  { result: '-1', expectResult: 'MISMATCH', expectCode: 'TENCENT_-1' },
  { result: '-2', expectResult: 'INVALID_INPUT', expectCode: 'TENCENT_-2' },
  { result: '-3', expectResult: 'INVALID_INPUT', expectCode: 'TENCENT_-3' },
  { result: '-4', expectResult: 'PROVIDER_ERROR', expectCode: 'TENCENT_-4' },
  { result: '-5', expectResult: 'MISMATCH', expectCode: 'TENCENT_-5' },
  { result: '-6', expectResult: 'PROVIDER_ERROR', expectCode: 'TENCENT_-6' },
  { result: '-7', expectResult: 'PROVIDER_ERROR', expectCode: 'TENCENT_-7' },
  { result: '-99', expectResult: 'PROVIDER_ERROR', expectCode: 'TENCENT_-99' }, // 未知非 0 → PROVIDER_ERROR
  { result: undefined, expectResult: 'PROVIDER_ERROR', expectCode: 'TENCENT_UNKNOWN' }, // 无 Result → 安全降级
];

let pass = 0;
let fail = 0;

for (const c of cases) {
  const out = mapTencentResult(c.result, RID);
  const okResult = out.result === c.expectResult;
  const okCode = c.expectCode === null
    ? out.failureReasonCode === undefined
    : out.failureReasonCode === c.expectCode;
  const okRid = (out.providerRequestId ?? '') === RID;
  const ok = okResult && okCode && okRid;
  if (ok) {
    pass++;
    console.log(`PASS  Result=${JSON.stringify(c.result)} -> ${out.result} (${out.failureReasonCode ?? '-'}) rid=${out.providerRequestId}`);
  } else {
    fail++;
    console.log(`FAIL  Result=${JSON.stringify(c.result)} -> got ${out.result}/${out.failureReasonCode ?? '-'} (ridOk=${okRid}); expected ${c.expectResult}/${c.expectCode ?? '-'}`);
  }
}

// 额外断言：VERIFIED 不得携带 failureReasonCode（避免泄露）。
const v = mapTencentResult('0', RID);
if (v.failureReasonCode !== undefined) {
  fail++;
  console.log(`FAIL  VERIFIED must not carry failureReasonCode, got ${v.failureReasonCode}`);
}

console.log(`\nTENCENT RESULT MAPPING: pass=${pass} fail=${fail} total=${cases.length + 1}`);
process.exit(fail === 0 ? 0 : 1);
