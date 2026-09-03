/**
 * 考勤位置输入校验（S2-6k2 V1 —— Location Capture Foundation）。
 *
 * 坐标系契约（用户 §2，基于 1.0 实证，非假设）：
 * - 全系统 GCJ-02（腾讯地图 / wx.chooseLocation / wx.getLocation({type:'gcj02'}) 输出）。
 * - 服务端【不】做坐标系转换（不转 WGS-84 / GCJ-02 / BD-09），避免在服务端引入
 *   中国偏移算法的维护负担与误差。
 * - 关键约束：服务端仅凭 latitude/longitude 数值【无法】证明客户端真的提交了 GCJ-02。
 *   因此 GCJ-02 是 API CONTRACT，不是 server-side detectable property。
 *   服务端只验证 numeric validity（见下）。
 *
 * 范围（用户 §9 / §11）：本模块只做 parse + validate + normalize，不计算 distance、
 * 不读取 activity 地理配置、不写任何异常。distance 计算属 Detector Core（后续切片）。
 *
 * 缺失 / 空 语义（用户 §4 / §5）：
 * - missing（字段不存在） / null → 视为 GPS 不可用 → 返回 null（不阻断签到）。
 * - 提供 object → 必须 latitude + longitude 成对存在且合法；accuracy 可选。
 * - partial（只有其一） / 非 object / 非数字 / 越界 → AppError INVALID_PARAM（400）。
 */

import { AppError, ErrorCode, invalidParam } from './errors';

/** 规范化后的签到位置（GCJ-02 坐标 + 可选精度，单位米）。 */
export interface AttendanceLocation {
  /** GCJ-02 纬度，[-90, 90]。 */
  latitude: number;
  /** GCJ-02 经度，[-180, 180]。 */
  longitude: number;
  /** 客户端位置估计精度半径（米）；可选，必须 > 0。 */
  accuracy?: number;
}

const LAT_MIN = -90;
const LAT_MAX = 90;
const LNG_MIN = -180;
const LNG_MAX = 180;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 解析并校验请求体中的 location 字段。
 *
 * @param raw 已经从请求体提取出的 body.location 值（未提供则为 undefined）。
 * @returns 规范化位置；missing / null / undefined → 返回 null（GPS 不可用，合法）。
 * @throws AppError(INVALID_PARAM, 400) 当提供了 object 但字段非法 / 不完整。
 */
export function parseAttendanceLocation(raw: unknown): AttendanceLocation | null {
  // missing / explicit null → GPS 不可用（合法，不阻断签到）。
  if (raw === undefined || raw === null) return null;

  // 非 object（含数组、字符串、数字）→ 400。
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalidParam('location', 'must be an object or null');
  }

  const obj = raw as Record<string, unknown>;
  const { latitude, longitude, accuracy } = obj;

  // latitude / longitude 必须成对存在且为有限数字（禁止字符串自动 Number() 转换）。
  if (!isFiniteNumber(latitude)) {
    throw invalidParam('latitude', 'must be a finite number');
  }
  if (!isFiniteNumber(longitude)) {
    throw invalidParam('longitude', 'must be a finite number');
  }

  // 范围校验（边界 -90/90/-180/180 合法）。
  if (latitude < LAT_MIN || latitude > LAT_MAX) {
    throw invalidParam('latitude', `must be between ${LAT_MIN} and ${LAT_MAX}`);
  }
  if (longitude < LNG_MIN || longitude > LNG_MAX) {
    throw invalidParam('longitude', `must be between ${LNG_MIN} and ${LNG_MAX}`);
  }

  // accuracy 可选；若提供必须为有限数字且 > 0（语义 = 客户端估计精度半径，米）。
  // 不在此设置任意未经业务冻结的 hard max（用户 §8）。
  let normAccuracy: number | undefined;
  if (accuracy !== undefined) {
    if (!isFiniteNumber(accuracy)) {
      throw invalidParam('accuracy', 'must be a finite number when provided');
    }
    if (accuracy <= 0) {
      throw invalidParam('accuracy', 'must be greater than 0');
    }
    normAccuracy = accuracy;
  }

  return { latitude, longitude, accuracy: normAccuracy };
}
