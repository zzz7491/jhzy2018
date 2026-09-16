// miniprogram/utils/apiEnv.ts
// Core Journey V2 API environment routing（STEP 3）。
//
// 唯一职责：解析 V2 API base URL。
//
// 安全契约（编译期固定，fail closed）：
//   - 唯一授权的 production V2 literal 保存在本文件。
//   - 所有环境的 V2 base 均为【编译期常量】，绝不读取运行时 Storage。
//     已移除 JHZY_V2_TEST_BASE 用户可写覆盖（P2-A / L5），防止普通用户在
//     Storage 中注入任意 base 从而重定向全量请求（含 Bearer token）。
//   - release / 未知环境 -> 始终返回 PRODUCTION_V2_BASE。
//   - develop / trial -> 返回 DEV_V2_BASE（开发者在源码中【编译期】配置；
//     默认等同 production，如需指向自有测试 Worker 请在此处编译期修改）。

/** production V2 base（唯一来源，编译期常量） */
export const PRODUCTION_V2_BASE = 'https://api.jhzyfw.com/api/v2';

/**
 * 编译期开发环境 V2 base。
 * 注意：这是源码中的编译期常量，非运行时 Storage 注入。
 * 默认指向 production；如需在 develop / trial 下指向自有测试 Worker，
 * 请在此处编译期修改后重新构建，不要通过运行时 Storage 覆盖。
 */
export const DEV_V2_BASE = 'https://api.jhzyfw.com/api/v2';

function detectEnvVersion(): string {
  if (typeof wx === 'undefined' || typeof wx.getAccountInfoSync !== 'function') {
    // 运行环境不可用时，回落到 production（fail closed）
    return 'release';
  }
  let envVersion: any;
  try {
    const info: any = wx.getAccountInfoSync();
    envVersion = info && info.miniProgram ? info.miniProgram.envVersion : undefined;
  } catch (e) {
    // 读取失败 -> 回落 production（fail closed）
    return 'release';
  }
  if (envVersion !== 'develop' && envVersion !== 'trial' && envVersion !== 'release') {
    // 未知环境 -> 回落 production（fail closed）
    return 'release';
  }
  return envVersion as string;
}

/**
 * 解析 V2 API base URL。
 * 所有环境均返回编译期常量，绝不读取运行时 Storage。
 *   release / 未知 -> PRODUCTION_V2_BASE
 *   develop / trial -> DEV_V2_BASE
 */
export function resolveV2Base(): string {
  const envVersion = detectEnvVersion();
  if (envVersion === 'release') {
    return PRODUCTION_V2_BASE;
  }
  return DEV_V2_BASE;
}

export default resolveV2Base;
