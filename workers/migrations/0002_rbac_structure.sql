-- =============================================================================
-- 嘉禾志愿 2.0 —— D1 Migration 0002：RBAC 结构（S2-3 草案）
-- =============================================================================
-- 状态：本地 migration 草案，**未执行**、未建 D1、未运行 wrangler。
-- 范围：roles / permissions / role_permissions / user_roles 四表结构。
-- 种子：roles 表写入 6 个冻结角色（S2-2G 裁定 scope）。
-- 纪律：permissions 表**禁止 INSERT**（CONFIRMED permission code = 0）；
--       role_permissions 表**禁止 INSERT**（无角色-权限绑定）。
-- 跨表一致性（role.scope ↔ user_roles.scope_team_id）由 Worker RBAC service 强制，
--       不在 DB CHECK 内（SQLite 不支持跨表 CHECK）。
-- =============================================================================

PRAGMA defer_foreign_keys = ON;

-- roles：角色定义（PLATFORM_GLOBAL，无 team_id）
CREATE TABLE IF NOT EXISTS roles (
  id        INTEGER PRIMARY KEY,
  code      TEXT NOT NULL UNIQUE CHECK (
              code IN ('platform_super_admin','platform_operator','team_owner','team_admin','team_auditor','volunteer')),
  name      TEXT NOT NULL,
  scope     TEXT NOT NULL CHECK (scope IN ('platform','team')),
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  status    INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 6 个冻结角色 seed（scope 依 S2-2G 裁定）
INSERT INTO roles (code, name, scope, is_system, status) VALUES
  ('platform_super_admin', '平台超级管理员', 'platform', 1, 1),
  ('platform_operator',    '平台运营',       'platform', 1, 1),
  ('team_owner',           '团队负责人',     'team',     1, 1),
  ('team_admin',           '团队管理员',     'team',     1, 1),
  ('team_auditor',         '团队审计员',     'team',     1, 1),
  ('volunteer',            '志愿者',         'team',     1, 1);

-- permissions：仅结构，**禁止 INSERT**（CONFIRMED = 0）
CREATE TABLE IF NOT EXISTS permissions (
  id         INTEGER PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,                          -- <域>.<资源>.<动作>[.作用域]
  name       TEXT NOT NULL,
  perm_group TEXT,
  risk_level INTEGER NOT NULL DEFAULT 1 CHECK (risk_level IN (1,2,3)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
-- ⚠️ 在此阶段不写入任何 permission code。权限目录与授权矩阵留安全设计阶段解冻后补 seed。

-- role_permissions：仅结构，**禁止 INSERT binding**（无角色-权限绑定）
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE RESTRICT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (role_id, permission_id)
);
-- ⚠️ 在此阶段不写入任何角色-权限绑定。role_permissions 待 permissions 解冻后填充。

-- user_roles：用户-角色分配（PLATFORM_GLOBAL 记录；含 scope_team_id）
CREATE TABLE IF NOT EXISTS user_roles (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  scope_team_id INTEGER REFERENCES teams(id) ON DELETE RESTRICT,   -- NULL=平台级；非 NULL=团队级
  granted_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  granted_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at    INTEGER DEFAULT NULL,
  UNIQUE (user_id, role_id, scope_team_id)
);
CREATE INDEX IF NOT EXISTS idx_ur_team ON user_roles(scope_team_id);
CREATE INDEX IF NOT EXISTS idx_ur_user ON user_roles(user_id);

-- =============================================================================
-- 跨表 scope 一致性约束说明（设计为 RBAC service 层强制，非 DB CHECK）：
--   * PLATFORM 角色（platform_super_admin / platform_operator）：
--       scope_team_id 必须 IS NULL。
--   * TEAM 角色（team_owner / team_admin / team_auditor / volunteer）：
--       scope_team_id 必须 NOT NULL 且引用存在的 teams.id。
--   * 禁止 (user_id, role_id, scope_team_id) 重复；
--   * 禁止 scope_team_id IS NULL 的 volunteer 行（S2-2G 裁定 volunteer=TEAM）。
-- Worker 写入 user_roles 前须按 roles.scope 校验 scope_team_id 取值。
-- =============================================================================

-- 0002 结束。本文件为本地草案，未执行、未建 D1、未运行 wrangler。
