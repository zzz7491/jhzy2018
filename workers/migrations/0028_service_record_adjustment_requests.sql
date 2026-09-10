-- =============================================================================
-- 0028 — P35-C1：Service Time Adjustment Request Foundation（Schema）
-- =============================================================================
-- 依据：P35-A Reality Audit + P35-B 设计冻结（SERVICE_TIME_APPROVAL_DESIGN = FROZEN）。
--
-- 本阶段唯一目标（foundation only）：
--   1) 新建 service_record_adjustment_requests 表（双人审批 workflow 的状态载体）
--   2) 部分唯一索引：同一 service record 最多 1 个 PENDING
--   3) 最小必要索引（team_id / requester_id / status）
--
-- 本阶段明确不包含（禁止项，属 P35-C2 及以后）：
--   * 不实现 request / review / approve / reject 路由、service、repository workflow。
--   * 不修改现有 direct adjust runtime（routes/service-records.ts :publicId/adjust）。
--   * 不修改 service_records / service_record_audits / points_ledger / attendance_sessions。
--   * service_records.review_status 保持 dormant（单标量无法表达多次请求历史）。
--   * 不创建新 permission（复用 service.record.adjust = 提交申请 / service.record.review = 审核）。
--   * 不改动任何角色绑定。
--   * 不做任何 legacy 数据回填（新表上线即空）。
--
-- ---------------------------------------------------------------------------
-- 三快照语义（P35-B §1/§4 冻结）
-- ---------------------------------------------------------------------------
--   old_minutes_snapshot / old_points_awarded_units_snapshot /
--   old_settlement_status_snapshot 均为「创建申请时的原子快照」，
--   仅用于 approve 时的 stale / 并发保护，绝不参与积分计算（积分复用 SR_CTE target-net）。
--   old_settlement_status_snapshot 合法范围依据 0017：IN (0,1,2)。
--
-- ---------------------------------------------------------------------------
-- 来源列约束（P35-B §3/§4 冻结）
-- ---------------------------------------------------------------------------
--   requested_minutes：0 <= x <= 525600（SQL CHECK 强制）
--   三 snapshot：>= 0（SQL CHECK 强制）
--   reason / review_reason 长度由 runtime validation 负责（不依赖 SQL trim CHECK）

CREATE TABLE IF NOT EXISTS service_record_adjustment_requests (
  id                                INTEGER PRIMARY KEY,
  public_id                         TEXT NOT NULL UNIQUE,

  service_record_public_id          TEXT NOT NULL
                                      REFERENCES service_records(public_id) ON DELETE RESTRICT,
  team_id                           INTEGER NOT NULL
                                      REFERENCES teams(id) ON DELETE RESTRICT,
  requester_id                      INTEGER NOT NULL
                                      REFERENCES users(id) ON DELETE RESTRICT,

  old_minutes_snapshot              INTEGER NOT NULL
                                      CHECK (old_minutes_snapshot >= 0),
  old_points_awarded_units_snapshot INTEGER NOT NULL
                                      CHECK (old_points_awarded_units_snapshot >= 0),
  old_settlement_status_snapshot    INTEGER NOT NULL
                                      CHECK (old_settlement_status_snapshot IN (0, 1, 2)),

  requested_minutes                 INTEGER NOT NULL
                                      CHECK (requested_minutes >= 0 AND requested_minutes <= 525600),

  reason                            TEXT NOT NULL,

  status                            INTEGER NOT NULL DEFAULT 0
                                      CHECK (status IN (0, 1, 2, 3)),
  -- 0 PENDING / 1 APPROVED / 2 REJECTED / 3 CANCELLED

  requested_at                      INTEGER NOT NULL,

  reviewer_id                       INTEGER
                                      REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at                      INTEGER,
  review_reason                    TEXT,
  applied_at                       INTEGER,
  trace_id                         TEXT,

  created_at                       INTEGER NOT NULL,
  updated_at                       INTEGER NOT NULL
);

-- 同一 service record 最多一个 PENDING（部分唯一索引）
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_pending
  ON service_record_adjustment_requests(service_record_public_id)
  WHERE status = 0;

-- 后续查询最小必要索引（不过度建索引）
CREATE INDEX IF NOT EXISTS idx_srar_team      ON service_record_adjustment_requests(team_id);
CREATE INDEX IF NOT EXISTS idx_srar_requester ON service_record_adjustment_requests(requester_id);
CREATE INDEX IF NOT EXISTS idx_srar_status    ON service_record_adjustment_requests(status);
