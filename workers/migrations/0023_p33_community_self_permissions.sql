-- 0023 — P33-P2A Community SELF Publishing RBAC
-- 依据：P33-P2 = BLOCKED（volunteer SELF publishing 在既有 RBAC 下无法安全表达）。
--
-- 范围（严格，仅此两项）：
--   1) 新增 2 条 content SELF 权限
--   2) 新增 4 条 role_permissions 绑定（volunteer + platform_super_admin × 2）
--   目标计数：permissions 99 → 101、role_permissions 284 → 288。
--
-- 本迁移明确不包含（禁止项）：
--   content schema / content_type 'post' / comment public_id / report public_id
--       —— 属 P33-P3 migration 范围，本轮不做。
--   community routes / services / repositories
--   community frontend / utils/contentApi.ts
--   文件上传 / R2 绑定
--   随手公益（welfare）迁移
--   points / AI / qualification
--
-- 权威源：workers/scripts/permission-catalog.json（domain=content 已同步）。
-- 0003_seed_permissions.sql 为历史 migration，不回改；P33-P2A 采用增量 migration。

-- ---------------------------------------------------------------------------
-- A) permissions delta（2 条）
--    perm_group = domain、risk_level 1=LOW / 2=MEDIUM / 3=HIGH
--    （与 0003 / 0020 / 0021 seed 格式一致）
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO permissions (code, name, perm_group, risk_level) VALUES
  ('content.article.self.create', '创建本人社区内容', 'content', 1),
  ('content.article.self.update', '修改本人社区内容', 'content', 1);

-- ---------------------------------------------------------------------------
-- B) role_permissions delta（4 条 = 2 权限 × 2 角色）
--    仅绑定：volunteer（本人社区内容发布者）+ platform_super_admin（持全部权限）。
--    不绑定：platform_operator / team_owner / team_admin / team_auditor。
--
--    重要：本权限仅用于「允许进入 SELF route」。
--    真正的 ownership 必须由 service / repository 强制：
--      author_id = auth.userId
--      team_id   = auth.teamId
--    不得把 SELF enforcement 塞进通用 RBAC middleware。
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES
  ((SELECT id FROM roles WHERE code = 'volunteer'),            (SELECT id FROM permissions WHERE code = 'content.article.self.create')),
  ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'content.article.self.create')),
  ((SELECT id FROM roles WHERE code = 'volunteer'),            (SELECT id FROM permissions WHERE code = 'content.article.self.update')),
  ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'content.article.self.update'));
