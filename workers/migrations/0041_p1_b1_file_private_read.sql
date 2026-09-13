-- =============================================================================
-- P1-B1 — 0041：新增 file.private.read 权限（仅绑定 platform_super_admin）
--
-- 目标（P1-B1 授权）：
--   消除 FileService 中 `b.role === 'platform_super_admin'` 的硬编码角色授权。
--   将「同团队内、非上传者的 PRIVATE 文件读取」收敛为统一的 RBAC 权限
--   file.private.read，仅绑定 platform_super_admin。
--
-- 语义边界（严禁越界）：
--   - 仅允许在「既有团队作用域（findByPublicIdAndTeam）+ file.file.view 已授权」前提下，
--     读取 visibility=private 且 actor 非上传者的文件；
--   - 不是跨团队权限 / 不是全局文件权限 / 不是上传权限 / 不是删除权限 / 不是审计权限。
--
-- 约束（P1-B1 绝对边界）：
--   - 仅 INSERT OR IGNORE file.private.read 权限；
--   - 仅 INSERT OR IGNORE platform_super_admin 绑定；
--   - 不修改任何既有权限 / 历史迁移 / schema / community / audit；
--   - 路由层保留 file.file.view 门禁（不在本迁移处理）。
-- =============================================================================

INSERT OR IGNORE INTO permissions (code, name, perm_group, risk_level)
VALUES ('file.private.read', '读取团队内私有文件（非上传者）', 'file', 2);

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
VALUES (
  (SELECT id FROM roles WHERE code = 'platform_super_admin'),
  (SELECT id FROM permissions WHERE code = 'file.private.read')
);
