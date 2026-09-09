-- =============================================================================
-- 0027 — P34-C1：Activity Publication Approval Foundation（Schema + RBAC）
-- =============================================================================
-- 依据：P34-B 设计冻结（ACTIVITY_APPROVAL_DESIGN = FROZEN）。
--
-- 本阶段唯一目标（foundation only）：
--   1) activities 新增「发布审核」维度列（additive，不动现有列）
--   2) 确定性回填 audit_status
--   3) 新增审核查询索引
--   4) 新增 2 条 permission 定义 + 角色绑定
--
-- 本阶段明确不包含（禁止项，属 P34-C2 及以后）：
--   * 不修改任何 runtime 行为：
--       routes/activities.ts、services/activity-admin-service.ts、
--       repository/activities.ts、miniprogram/pages/admin/activity-*/** 一律不动。
--   * 不新增 submit / approve / reject 路由。
--   * 不实现自审拦截（submitted_by != reviewer）—— 该权威边界在 P34-C2 service 层实现。
--   * 不移除 runtime direct-publish route（P34-C2 处理）。
--   * 不新增 activity 专用 audit 表（冻结决定：复用 content_audit_logs）。
--   * 不修改 content_audit_logs schema。
--   * 不使用 / 不删除 / 不 rename publish_audit_by（见下 LEGACY_DORMANT）。
--
-- ---------------------------------------------------------------------------
-- 双状态模型（P34-B §A 冻结）
-- ---------------------------------------------------------------------------
--   A) lifecycle status（现有列，语义不变，本迁移不改写）
--        0 DRAFT / 1 SIGNUP_OPEN / 2 IN_PROGRESS / 3 ENDED / 4 CANCELLED / 5 UNPUBLISHED
--        （CHECK 仍为 0..7；6/7 保留未分配，绝不用于审核态）
--   B) publication audit_status（本迁移新增列）
--        0 DRAFT / 1 PENDING / 2 APPROVED / 3 REJECTED
--   两维度严格分离，不得混用。
--
-- ---------------------------------------------------------------------------
-- publish_audit_by：LEGACY_DORMANT
-- ---------------------------------------------------------------------------
--   该列自 0001 起存在，但经全仓检索 workers/src 从未被读写（无任何 runtime 使用）。
--   本迁移：
--     * 不删除（SQLite 不做 DROP COLUMN 历史兼容，且避免表重建风险）
--     * 不 rename（保持历史 schema diff 稳定）
--     * 不启用（本轮 runtime 不使用）
--   正式标记为 LEGACY_DORMANT；真实审核人由新列 reviewed_by 承载。
--
-- ---------------------------------------------------------------------------
-- 幂等性
-- ---------------------------------------------------------------------------
--   * CREATE INDEX         → IF NOT EXISTS，重复执行安全。
--   * permissions 插入     → INSERT OR IGNORE（code UNIQUE），重复执行安全。
--   * role_permissions 绑定→ INSERT OR IGNORE（PK role_id+permission_id），重复执行安全。
--   * 回填 UPDATE          → 确定性 CASE 映射，重复执行结果一致。
--   * ALTER TABLE ADD COLUMN：SQLite 不支持 IF NOT EXISTS，重复执行会报
--     "duplicate column name"。与其它 ALTER 类迁移一致，按项目约定由 migration
--     顺序（单调递增、单次应用）保证；本文件不伪造幂等。
-- =============================================================================

PRAGMA defer_foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 1) activities 新增列（additive only）
-- ---------------------------------------------------------------------------
ALTER TABLE activities ADD COLUMN audit_status INTEGER NOT NULL DEFAULT 0
  CHECK (audit_status IN (0,1,2,3));

ALTER TABLE activities ADD COLUMN submitted_by INTEGER REFERENCES users(id);
ALTER TABLE activities ADD COLUMN submitted_at INTEGER;
ALTER TABLE activities ADD COLUMN reviewed_by  INTEGER REFERENCES users(id);
ALTER TABLE activities ADD COLUMN reviewed_at  INTEGER;
ALTER TABLE activities ADD COLUMN reject_reason TEXT;

-- ---------------------------------------------------------------------------
-- 2) 确定性回填（P34-B §O 冻结映射）
--      status = 0            → audit_status = 0 (DRAFT)
--      status IN (1,2,3,4,5) → audit_status = 2 (APPROVED)
--      status IN (6,7)       → audit_status = 0 (DRAFT)   ← 安全缺省
--      ELSE（未知）          → audit_status = 0 (DRAFT)   ← 绝不强行 APPROVED
--    只写 audit_status；不修改 status / published_at / created_by 及任何业务数据。
-- ---------------------------------------------------------------------------
UPDATE activities
SET audit_status = CASE
  WHEN status = 0 THEN 0
  WHEN status IN (1,2,3,4,5) THEN 2
  WHEN status IN (6,7) THEN 0
  ELSE 0
END;

-- ---------------------------------------------------------------------------
-- 3) 索引（审核队列 / 志愿者可见性查询）
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_activities_team_audit_status
  ON activities(team_id, audit_status, status);

-- ---------------------------------------------------------------------------
-- 4) permission 定义（2 条）
--      perm_group = domain、risk_level 1=LOW / 2=MEDIUM / 3=HIGH
--      与 0003 / 0020 / 0023 seed 格式一致
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO permissions (code, name, perm_group, risk_level) VALUES
  ('activity.activity.submit', '提交活动发布审核', 'activity', 2),
  ('activity.activity.review', '活动发布审核（通过 / 驳回）', 'activity', 3);

-- ---------------------------------------------------------------------------
-- 5) role_permissions 绑定
--
--   submit（业务方动作，属活动创建/编辑方）：
--     授予：platform_super_admin / team_owner / team_admin
--     不授予：platform_operator / team_auditor / volunteer
--
--   review（独立审核动作，decide-only）：
--     授予：platform_super_admin / platform_operator / team_owner /
--           team_admin / team_auditor
--     不授予：volunteer
--
--   注意：
--     * activity.activity.publish 定义保留（P34-C2 才移除 runtime route），
--       本迁移不删除、不重新绑定。
--     * 同时持有 create + review 的角色并不等于可自审；
--       P34-C2 的 submitted_by != reviewer 才是职责分离权威边界。
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES
  -- submit
  ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'activity.activity.submit')),
  ((SELECT id FROM roles WHERE code = 'team_owner'),            (SELECT id FROM permissions WHERE code = 'activity.activity.submit')),
  ((SELECT id FROM roles WHERE code = 'team_admin'),            (SELECT id FROM permissions WHERE code = 'activity.activity.submit')),
  -- review
  ((SELECT id FROM roles WHERE code = 'platform_super_admin'),  (SELECT id FROM permissions WHERE code = 'activity.activity.review')),
  ((SELECT id FROM roles WHERE code = 'platform_operator'),     (SELECT id FROM permissions WHERE code = 'activity.activity.review')),
  ((SELECT id FROM roles WHERE code = 'team_owner'),            (SELECT id FROM permissions WHERE code = 'activity.activity.review')),
  ((SELECT id FROM roles WHERE code = 'team_admin'),            (SELECT id FROM permissions WHERE code = 'activity.activity.review')),
  ((SELECT id FROM roles WHERE code = 'team_auditor'),          (SELECT id FROM permissions WHERE code = 'activity.activity.review'));
