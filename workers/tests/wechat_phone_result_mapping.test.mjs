#!/usr/bin/env node
/**
 * P0-B：mapWechatErrCode 确定性映射单测。
 *
 * 通过 esbuild 将 src/providers/wechat/phone-client.ts 打包为 ESM（处理参数属性等
 * strip-only 不支持的语法），再以 data: URL 动态导入，验证微信 getuserphonenumber
 * 错误码 → 内部状态（INVALID_CODE / PROVIDER_ERROR）映射稳定。
 *
 * 运行：node tests/wechat_phone_result_mapping.test.mjs
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    process.stderr.write(`  PASS ${name}\n`);
  } else {
    fail += 1;
    process.stderr.write(`  FAIL ${name} ${detail}\n`);
  }
}

async function main() {
  let mapWechatErrCode;
  try {
    const entry = fileURLToPath(new URL('../src/providers/wechat/phone-client.ts', import.meta.url));
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
    });
    const code = result.outputFiles[0].text;
    const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
    mapWechatErrCode = mod.mapWechatErrCode;
    if (typeof mapWechatErrCode !== 'function') throw new Error('mapWechatErrCode not exported');
  } catch (e) {
    process.stderr.write(`IMPORT_FAILED ${String(e)}\n`);
    process.exitCode = 1;
    return;
  }

  // 40029：code 无效/已使用/过期 → 用户授权问题 → INVALID_CODE（前端可重试授权）。
  check("40029 → INVALID_CODE", mapWechatErrCode(40029) === 'INVALID_CODE', String(mapWechatErrCode(40029)));
  check("'40029' 字符串 → INVALID_CODE", mapWechatErrCode('40029') === 'INVALID_CODE', String(mapWechatErrCode('40029')));

  // -1 系统繁忙 / 40013 appid 不匹配 / 45011 频率限制 / 其它 → 上游错误 → PROVIDER_ERROR。
  check("-1 → PROVIDER_ERROR", mapWechatErrCode(-1) === 'PROVIDER_ERROR', String(mapWechatErrCode(-1)));
  check("40013 → PROVIDER_ERROR", mapWechatErrCode(40013) === 'PROVIDER_ERROR', String(mapWechatErrCode(40013)));
  check("45011 → PROVIDER_ERROR", mapWechatErrCode(45011) === 'PROVIDER_ERROR', String(mapWechatErrCode(45011)));
  check("12345 未知 → PROVIDER_ERROR", mapWechatErrCode(12345) === 'PROVIDER_ERROR', String(mapWechatErrCode(12345)));

  // 成功码 / 缺省 → PROVIDER_ERROR（映射仅处理错误码；成功由 errcode==0 分支处理，不在此函数）。
  check("0 → PROVIDER_ERROR（错误码映射不处理成功）", mapWechatErrCode(0) === 'PROVIDER_ERROR', String(mapWechatErrCode(0)));
  check("undefined → PROVIDER_ERROR", mapWechatErrCode(undefined) === 'PROVIDER_ERROR', String(mapWechatErrCode(undefined)));
  check("null → PROVIDER_ERROR", mapWechatErrCode(null) === 'PROVIDER_ERROR', String(mapWechatErrCode(null)));

  // 确定性：同一输入多次调用结果一致。
  check("确定性：40029 多次调用一致", mapWechatErrCode(40029) === 'INVALID_CODE' && mapWechatErrCode(40029) === 'INVALID_CODE');
  check("确定性：40013 多次调用一致", mapWechatErrCode(40013) === 'PROVIDER_ERROR' && mapWechatErrCode(40013) === 'PROVIDER_ERROR');

  process.stderr.write(`\nMAP TOTAL: ${pass} pass, ${fail} fail\n`);
  if (fail > 0) process.stderr.write(`MAP FAILED\n`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => {
  process.stderr.write(`FATAL ${String(e)}\n`);
  process.exitCode = 1;
});
