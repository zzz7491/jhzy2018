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
  // P36-C3-2（新增，纯增量）：AI best-effort 成本护栏（BEST_EFFORT_COST_GUARD）触发限流。
  // HTTP 429；details 只返回窗口与安全 retry 建议，绝不返回计数明细 / 凭证 / provider 细节。
  RATE_LIMITED: 'RATE_LIMITED',
  // P0-A（新增，纯增量）：志愿者身份核验域稳定错误码（不暴露供应商专有细节 / 身份证明文 / Secret）。
  // 与既有 error envelope 一致，不创建第二套。HTTP：INVALID_INPUT=400 / IDENTITY_MISMATCH=409 /
  // IDENTITY_PROVIDER_UNAVAILABLE=503 / IDENTITY_REVIEW_REQUIRED 由 200 响应体内 code 携带 / AUTH_REQUIRED=401(既有)。
  INVALID_INPUT: 'INVALID_INPUT',
  IDENTITY_MISMATCH: 'IDENTITY_MISMATCH',
  IDENTITY_PROVIDER_UNAVAILABLE: 'IDENTITY_PROVIDER_UNAVAILABLE',
  IDENTITY_REVIEW_REQUIRED: 'IDENTITY_REVIEW_REQUIRED',
  // P36-C3-3（新增，纯增量）：AI provider / config / timeout 统一折叠为安全 503。
  // 不泄露上游 body / 端点 / 凭证 / stack；details 仅携带稳定 reason token。
  AI_UNAVAILABLE: 'AI_UNAVAILABLE',
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
  // P35-C2（新增，纯增量）：服务时长人工修正「申请 → 双人审批」工作流冲突。
  // HTTP 409；details.reason 只携带稳定业务 token，不含 SQL / 表名 / 内部 id / 内部 numeric id。
  ADJUSTMENT_PENDING_EXISTS: 'adjustment_pending_exists', // 同一 service record 已存在 PENDING 申请（部分唯一索引兜底）
  ADJUSTMENT_INVALID_TRANSITION: 'adjustment_invalid_transition', // 申请不处于 PENDING（已审批/已拒绝/已取消）不可再审批/拒绝
  ADJUSTMENT_STALE: 'adjustment_stale', // approve 时快照与当前 service record 不一致（minutes/points/settlement_status 漂移），保持 PENDING
  ADJUSTMENT_NOT_ALLOWABLE: 'adjustment_not_allowable', // 目标 service record 非 EFFECTIVE(1)，不可发起修正申请
  // P24-P2D-REV1（新增，纯增量）：积分商城兑换业务冲突——余额 / 库存。
  // HTTP 409；details.reason 只携带稳定业务 token，不含 SQL / 表名 / 内部 id /
  // 当前余额数值 / 真实库存数字（避免给客户端提供余额/库存探测信号）。
  MALL_INSUFFICIENT_BALANCE: 'mall_insufficient_balance', // 积分账户不存在 / 余额不足以兑换该商品（统一按"余额不足"语义，不区分无账户）
  MALL_OUT_OF_STOCK: 'mall_out_of_stock', // 商品库存已耗尽（不泄露真实库存）
  // P25-P3B1（新增，纯增量）：积分兑换订单核销冲突——订单在 TEAM 内存在但状态不可核销（RESERVED 3/4）。
  // HTTP 409；details.reason 只携带稳定业务 token，不含 SQL / 表名 / 内部 id / 内部订单状态含义。
  MALL_ORDER_NOT_VERIFIABLE: 'mall_order_not_verifiable', // 订单存在但状态不可核销（仅 status ∈ {3,4} 时返回）
  // P32-P2（新增，纯增量）：考试 / 证书域业务冲突。
  // HTTP 409；details.reason 只携带稳定业务 token，不含 SQL / 表名 / 内部 id / 答案内容。
  EXAM_ACTIVE_ATTEMPT_CONFLICT: 'exam_active_attempt_conflict', // 同一用户+试卷已存在活跃 attempt（并发 start 唯一约束命中）
  EXAM_ALREADY_SUBMITTED: 'exam_already_submitted', // session 已是 COMPLETED，禁止重复写（idempotent read 除外）
  EXAM_MAX_ATTEMPTS_REACHED: 'exam_max_attempts_reached', // 达到 exam_papers.max_attempts 上限
  EXAM_POOL_EXHAUSTED: 'exam_pool_exhausted', // cert_trn 号池无可用编号（passed=1 且需发证时）
  EXAM_CERT_ALREADY_EXISTS: 'exam_cert_already_exists', // 该 (user_id, exam_paper_id) 已有 active 证书（重考不发第二张）
  // P34-C2（新增，纯增量）：活动发布审核状态机冲突。
  // HTTP 409；details.reason 只携带稳定业务 token，不含 SQL / 表名 / 内部 id / 审核人身份。
  ACTIVITY_APPROVAL_TRANSITION: 'activity_approval_transition', // 当前 audit_status 不允许该转换（无效状态跃迁）
  ACTIVITY_APPROVAL_RACE: 'activity_approval_race', // 并发转换：条件更新未命中（状态已被并发修改）
  // P36-C3-2（新增，纯增量）：AI conversation CAS 冲突。
  // HTTP 409；details.reason 只携带稳定业务 token，不含 SQL / 表名 / 内部 id / 消息内容。
  CONVERSATION_STALE: 'conversation_stale', // append 时 expectedMessagesRaw 与当前存储不一致（并发追加 / 基于旧快照）
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
 * AI 频率限制（P36-C3-2）：HTTP 429。
 * - `AI_RATE_LIMIT_TYPE = BEST_EFFORT_COST_GUARD`——成本护栏，**不是**严格并发 quota。
 * - details 仅携带稳定窗口 token + 安全 retry 建议秒数；不返回计数明细 / 上游信息 / 凭证。
 */
export function aiRateLimited(window: 'minute' | 'day', retryAfterSeconds: number): AppError {
  return new AppError(ErrorCode.RATE_LIMITED, 429, 'Too many AI requests', {
    window,
    retry_after_seconds: String(Math.max(1, Math.floor(retryAfterSeconds))),
  });
}

/** AI 不可用稳定 reason token（不暴露上游细节 / 端点 / 凭证 / stack）。 */
export type AIUnavailableReason = 'ai_unavailable' | 'ai_timeout' | 'ai_upstream_error';

/**
 * AI 不可用（P36-C3-3）：provider / config / timeout → 统一 503。
 * - message 固定「AI service unavailable」，不携带任何上游信息。
 * - details.reason 仅允许以下稳定 token：
 *     config_error   → ai_unavailable（无需向客户端区分配置错误细节）
 *     timeout        → ai_timeout
 *     provider_error → ai_upstream_error
 * - 绝不返回：provider raw body / endpoint / API key / Authorization / stack / 内部异常 message。
 */
export function aiUnavailable(reason: AIUnavailableReason): AppError {
  return new AppError(ErrorCode.AI_UNAVAILABLE, 503, 'AI service unavailable', { reason });
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
