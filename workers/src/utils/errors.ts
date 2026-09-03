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
