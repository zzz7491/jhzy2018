-- =============================================================================
-- 嘉禾志愿 2.0 —— D1 Migration 0017：ServiceRecord Settlement + Permission Delta（P22-P1）
-- =============================================================================
-- 本迁移承载两部分内容（P22-P1 仅此一处写权限；0003_seed_permissions.sql 字节不变）：
--   A) ServiceRecord 结算所需 schema delta（service_records / activities / service_record_audits）
--   B) 2 个新权限 + 7 个角色绑定（权限模型权威源 = permission-catalog.json；此处仅物理 seed）
--
-- 设计冻结依据：
--   P22-DESIGN-REV3 = PASS
--   P22 IMPLEMENTATION PREFLIGHT REV2 = PASS
--     （权限部署采用 Option B：0003 字节不变，0017 承载 permission delta）
--
-- 历史兼容原则（不可动摇）：
--   - 已有 service_records 行的 settlement_status 统一置 0 (UNVERIFIED)；0017 不自动认证历史事实。
--   - 历史行 points_awarded_units = 0；不追溯发积分。
--   - 历史行 public_id 按内部 id 确定性生成（'L' + 12 位零填充 id），与 runtime ULID 命名空间隔离。
--   - business_service_date 从 attendance_sessions.business_service_date 按 session_id 回填；无源值保持 NULL。
--   - 下游永远只消费 settlement_status = 1 (EFFECTIVE)；0 与 2 一律不消费。
-- =============================================================================

PRAGMA defer_foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- A1) service_records：保留 minutes（不 rename），新增结算列
-- ---------------------------------------------------------------------------
ALTER TABLE service_records
  ADD COLUMN public_id TEXT;

ALTER TABLE service_records
  ADD COLUMN business_service_date TEXT;

ALTER TABLE service_records
  ADD COLUMN points_min_minutes INTEGER NOT NULL DEFAULT 30;

ALTER TABLE service_records
  ADD COLUMN points_base_units_per_hour INTEGER NOT NULL DEFAULT 100;

ALTER TABLE service_records
  ADD COLUMN points_multiplier_pct INTEGER NOT NULL DEFAULT 100
    CHECK (points_multiplier_pct BETWEEN 100 AND 200);

ALTER TABLE service_records
  ADD COLUMN points_awarded_units INTEGER NOT NULL DEFAULT 0;

ALTER TABLE service_records
  ADD COLUMN settlement_status INTEGER NOT NULL DEFAULT 0
    CHECK (settlement_status IN (0,1,2));
-- 0 = UNVERIFIED（未认证，下游一律不得消费）
-- 1 = EFFECTIVE（有效，可被服务时长统计 / P23 积分 / 排行榜 / Growth / 证书 消费）
-- 2 = REVOKED（已撤销，不可消费）

-- ---------------------------------------------------------------------------
-- A2) service_records：历史 public_id 确定性回填
--     'L' 前缀不在 Crockford ULID 字母表（排除 I/L/O/U）内，与 runtime ULID 命名空间隔离；
--     按内部主键 id 零填充生成，稳定且唯一。
-- ---------------------------------------------------------------------------
UPDATE service_records
  SET public_id = 'L' || substr('000000000000' || id, -12)
  WHERE public_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sr_public_id
  ON service_records(public_id);

-- ---------------------------------------------------------------------------
-- A3) service_records：business_service_date 按 session_id 从 attendance_sessions 回填
--     无源值的行保持 NULL（COALESCE 兜底）。
-- ---------------------------------------------------------------------------
UPDATE service_records
  SET business_service_date = COALESCE(
    (SELECT s.business_service_date
       FROM attendance_sessions s
       WHERE s.id = service_records.session_id),
    business_service_date)
  WHERE business_service_date IS NULL;

-- ---------------------------------------------------------------------------
-- A4) service_records：索引（仅冻结的两个；不创建 speculative settlement_status 索引）
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_sr_team_bizdate
  ON service_records(team_id, business_service_date);

-- ---------------------------------------------------------------------------
-- A5) activities：新增积分倍率（>=160 必填 reason 由 service 层校验，DB 不强制复杂约束）
-- ---------------------------------------------------------------------------
ALTER TABLE activities
  ADD COLUMN points_multiplier_pct INTEGER NOT NULL DEFAULT 100
    CHECK (points_multiplier_pct BETWEEN 100 AND 200);

ALTER TABLE activities
  ADD COLUMN points_multiplier_reason TEXT;

-- ---------------------------------------------------------------------------
-- A6) service_record_audits：新增积分审计列
-- ---------------------------------------------------------------------------
ALTER TABLE service_record_audits
  ADD COLUMN old_points_awarded_units INTEGER NOT NULL DEFAULT 0;

ALTER TABLE service_record_audits
  ADD COLUMN new_points_awarded_units INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- B) 权限 delta（与 permission-catalog.json 同步；0003 不改，幂等插入）
--    permission 模型权威源 = permission-catalog.json；此处仅物理 seed，保证
--    fresh DB（0003:92 + 0017:+2 = 94）与 existing DB（0016:92 + 0017:+2 = 94）一致。
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO permissions (code, name, perm_group, risk_level) VALUES
  ('service.record.read', '查看本人服务时长记录（SELF）', 'service', 1),
  ('service.record.view', '查看团队服务时长记录（TEAM）', 'service', 1);

INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES
  ((SELECT id FROM roles WHERE code = 'volunteer'),           (SELECT id FROM permissions WHERE code = 'service.record.read')),
  ((SELECT id FROM roles WHERE code = 'platform_super_admin'),(SELECT id FROM permissions WHERE code = 'service.record.read')),
  ((SELECT id FROM roles WHERE code = 'team_owner'),           (SELECT id FROM permissions WHERE code = 'service.record.view')),
  ((SELECT id FROM roles WHERE code = 'team_admin'),           (SELECT id FROM permissions WHERE code = 'service.record.view')),
  ((SELECT id FROM roles WHERE code = 'team_auditor'),         (SELECT id FROM permissions WHERE code = 'service.record.view')),
  ((SELECT id FROM roles WHERE code = 'platform_super_admin'),(SELECT id FROM permissions WHERE code = 'service.record.view')),
  ((SELECT id FROM roles WHERE code = 'platform_operator'),    (SELECT id FROM permissions WHERE code = 'service.record.view'));
