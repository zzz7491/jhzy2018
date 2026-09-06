/**
 * 统一错误体系（S2-5）。
 *
 * 纪律（用户 §七 / §十五 L）：
 * - 不向客户端暴露 SQL、表名、文件路径、Secrets、stack trace。
 * - 所有错误经 middleware/error-handler.ts 统一转换为 ApiFailure。
 */

/** API 错误码（技术层；permission code 目录与此无关且保持冻结）。 */
export const ErrorCode = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  FORBIDDEN: 'FORBIDDEN',
  PERMISSION_CATALOG_FROZEN: 'PERMISSION_CATALOG_FROZEN',
  ROLE_NOT_ALLOWED: 'ROLE_NOT_ALLOWED',
  TEAM_SCOPE_REQUIRED: 'TEAM_SCOPE_REQUIRED',
  USER_SCOPE_REQUIRED: 'USER_SCOPE_REQUIRED',
  NOT_FOUND: 'NOT_FOUND',
  INVALID_PARAM: 'INVALID_PARAM',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  // S2-6c-3（新增，纯增量，不影响既有码）：
  CSRF_FAILED: 'CSRF_FAILED',
  IDENTITY_CONFLICT: 'IDENTITY_CONFLICT',
  // S2-6g（新增，纯增量）：业务状态冲突——重复报名 / 活动未开放报名 / 活动禁止取消。
  // HTTP 409；details.reason 只携带稳定业务 token，不含 SQL / 表名 / 内部 id。
  CONFLICT: 'CONFLICT',
} as const;

/** S2-6g：409 冲突的稳定业务 reason token（非敏感，可安全返回客户端）。 */
export const ConflictReason = {
  /** 该活动当前不处于开放报名状态（activities.status != 1）。 */
  ACTIVITY_SIGNUP_CLOSED: 'activity_signup_closed',
  /** 已存在该用户在活动下的报名行（UNIQUE(user_id, activity_id) 命中）。 */
  SIGNUP_ALREADY_EXISTS: 'signup_already_exists',
  /** 活动配置禁止取消报名（activities.allow_cancel = 0）。 */
  ACTIVITY_CANCEL_NOT_ALLOWED: 'activity_cancel_not_allowed',
  /** 并发竞争下的重复落库，被数据库唯一约束拦截。 */
  SIGNUP_DUPLICATE_RACE: 'signup_duplicate_race',
  // S2-6h（新增，纯增量）：签到状态冲突——未报名 / 重复签到 / 未签到先签退 / 已签退。
  // HTTP 409；details.reason 只携带稳定业务 token，不含 SQL / 表名 / 内部 id。
  ATTENDANCE_NOT_SIGNED_UP: 'attendance_not_signed_up',
  ATTENDANCE_ALREADY_CHECKED_IN: 'attendance_already_checked_in',
  ATTENDANCE_CHECKIN_REQUIRED: 'attendance_checkin_required',
  ATTENDANCE_ALREADY_CHECKED_OUT: 'attendance_already_checked_out',
  // S2-6i（新增，纯增量）：审核 / 强制签退状态冲突——已经审核 / 非活跃会话。
  // HTTP 409；details.reason 只携带稳定业务 token，不含 SQL / 表名 / 内部 id。
  ATTENDANCE_ALREADY_REVIEWED: 'attendance_already_reviewed',
  ATTENDANCE_NOT_ACTIVE: 'attendance_not_active',
  // S2-6j（新增，纯增量）：异常处置状态冲突——已 CONFIRMED(2) / 已 DISMISSED(3) 不再接受重复处置。
  // HTTP 409；details.reason 只携带稳定业务 token，不含 SQL / 表名 / 内部 id。
  ATTENDANCE_ANOMALY_ALREADY_HANDLED: 'attendance_anomaly_already_handled',
  // S2-NEW-ARCH-P11（新增，纯增量）：参与/排班分配状态冲突。
  // HTTP 409；details.reason 只携带稳定业务 token，不含 SQL / 表名 / 内部 id / 内部 participation id。
  // 冻结 6 类（无 future/optional）：
  SLOT_AT_CAPACITY: 'slot_at_capacity', // 时段硬容量已满（capacity>0 且活跃参与数已达上限）
  PSP_MISSING: 'psp_missing', // slot + occurrence_position 同时给定，但 participation_slot_positions 无活跃配置
  PARENT_MISMATCH: 'parent_mismatch', // signup/occurrence/slot/op/position 跨父级不一致或父级未处于有效状态
  CROSS_MODE_CONFLICT: 'cross_mode_conflict', // occurrence-level 与 slot-level 互斥（同 signup+occurrence 已存在另一模式）
  OLD_NOT_ACTIVE: 'old_not_active', // reassign 的 old 参与行非活跃（已取消 / 非 slot-level / slot 相同）
  PUBLIC_ID_CONFLICT: 'public_id_conflict', // 客户端 new_public_id 已存在但与本次指纹不一致 / 命中自然重复（不泄露冲突行）
  // S2-NEW-ARCH-P19（新增，纯增量）：deterministic ensure 目标 occurrence 存在 active slot，
  // 不可确定性物化，必须人工选择（P11 create / slot 级）。
  PARTICIPATION_REQUIRES_MANUAL: 'participation_requires_manual',
  // S2-NEW-ARCH-P16（新增，纯增量）：签到所引用的 Participation 已取消（非 assigned）。
  // HTTP 409；与 attendance_not_signed_up 区分——用户已报名且已排班，只是排班被取消。
  ATTENDANCE_PARTICIPATION_NOT_ACTIVE: 'attendance_participation_not_active',
  // S2-NEW-ARCH-P20（新增，纯增量）：通用动态表单引擎。
  // HTTP 409；details.reason 只携带稳定业务 token，不含 SQL / 表名 / 内部 id。
  FORM_VERSION_STALE: 'form_version_stale', // 提交/draft 指向的 version 已不是当前 published version
  FORM_SUBMISSION_DUPLICATE: 'form_submission_duplicate', // 同 grain（definition+submitter+consumer）已存在活跃 submitted
  FORM_NOT_AVAILABLE: 'form_not_available', // 合法 consumer 上不存在可用 published form（仅此场景可返回该 reason）
  // S2-NEW-ARCH-P21（新增，纯增量）：signup 消费 binding 策略为 required(2) 但未提供 submitted form。
  SIGNUP_FORM_REQUIRED: 'signup_form_required',
  // S2-NEW-ARCH-P22（新增，纯增量）：ServiceRecord 人工修正（adjust）冲突。
  // HTTP 409；details.reason 只携带稳定业务 token，不含 SQL / 表名 / 内部 id。
  SERVICE_RECORD_NO_CHANGE: 'service_record_no_change', // 提交的 effective_minutes 与当前值相同（无变化可审计）
  SERVICE_RECORD_STALE: 'service_record_stale', // 乐观锁未命中：记录已被并发修改 / 已不存在于本团队
  // P24-P2D-REV1（新增，纯增量）：积分商城兑换业务冲突——余额 / 库存。
  // HTTP 409；details.reason 只携带稳定业务 token，不含 SQL / 表名 / 内部 id /
  // 当前余额数值 / 真实库存数字（避免给客户端提供余额/库存探测信号）。
  MALL_INSUFFICIENT_BALANCE: 'mall_insufficient_balance', // 积分账户不存在 / 余额不足以兑换该商品（统一按"余额不足"语义，不区分无账户）
  MALL_OUT_OF_STOCK: 'mall_out_of_stock', // 商品库存已耗尽（不泄露真实库存）
} as const;

export type ConflictReasonValue = (typeof ConflictReason)[keyof typeof ConflictReason];

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 应用错误：携带稳定错误码 + HTTP 状态；内部信息禁止进入 message/details。 */
export class AppError extends Error {
  readonly code: ErrorCodeValue;
  readonly status: number;
  readonly details?: Record<string, string>;

  constructor(code: ErrorCodeValue, status: number, message: string, details?: Record<string, string>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function authRequired(): AppError {
  return new AppError(ErrorCode.AUTH_REQUIRED, 401, 'Authentication required');
}

export function forbidden(message = 'Forbidden'): AppError {
  return new AppError(ErrorCode.FORBIDDEN, 403, message);
}

export function permissionCatalogFrozen(): AppError {
  return new AppError(
    ErrorCode.PERMISSION_CATALOG_FROZEN,
    403,
    'Permission catalog is frozen (CONFIRMED=0); this operation is not authorized yet',
  );
}

export function roleNotAllowed(): AppError {
  return new AppError(ErrorCode.ROLE_NOT_ALLOWED, 403, 'Role not allowed for this resource');
}

export function teamScopeRequired(): AppError {
  return new AppError(ErrorCode.TEAM_SCOPE_REQUIRED, 403, 'Team context required for this resource');
}

export function userScopeRequired(): AppError {
  return new AppError(ErrorCode.USER_SCOPE_REQUIRED, 403, 'User context required for this resource');
}

export function notFound(resource = 'Resource'): AppError {
  return new AppError(ErrorCode.NOT_FOUND, 404, `${resource} not found`);
}

/**
 * 404 且带稳定 reason（S2-NEW-ARCH-P20 最小扩展）。
 * 既有普通 notFound() 调用完全不受影响；本 helper 仅用于「合法 consumer 上无可用 published form」
 * 这类「可安全区分、不构成跨团队泄露」的场景（P20：form_not_available）。
 */
export function notFoundReason(reason: string, resource = 'Resource'): AppError {
  return new AppError(ErrorCode.NOT_FOUND, 404, `${resource} not available`, { reason });
}

export function invalidParam(param: string, reason: string): AppError {
  return new AppError(ErrorCode.INVALID_PARAM, 400, `Invalid parameter: ${param}`, { [param]: reason });
}

export function internalError(): AppError {
  // 刻意不携带任何内部信息（无 SQL / 表名 / 路径 / stack）。
  return new AppError(ErrorCode.INTERNAL_ERROR, 500, 'Internal server error');
}

/**
 * 业务状态冲突（S2-6g）：HTTP 409。
 * - message 固定文案（不含内部信息）；区分维度只由 details.reason 的稳定 token 承载。
 * - reason 取自 ConflictReason，不含 SQL / 表名 / 内部 id / permission id。
 */
export function conflict(reason: ConflictReasonValue): AppError {
  return new AppError(ErrorCode.CONFLICT, 409, 'Resource state conflict', { reason });
}

/**
 * CSRF 校验失败（S2-6c-3）。403 + 固定文案，不回显缺失的是 Origin 还是 Header
 * （避免给攻击者提供逐项探测信号）。
 */
export function csrfFailed(): AppError {
  return new AppError(ErrorCode.CSRF_FAILED, 403, 'CSRF validation failed');
}

/**
 * 微信身份冲突（S2-6c-3 OPEN-7）：unionid 与 openid 命中两个不同 user 主体。
 * - HTTP 403；message 与"微信服务不可用"完全一致，避免攻击者据此枚举账号关联关系。
 * - 需要区分时只能依赖 code（IDENTITY_CONFLICT），code 本身不含任何身份信息。
 */
export function identityConflict(): AppError {
  return new AppError(ErrorCode.IDENTITY_CONFLICT, 403, 'Authentication unavailable');
}
