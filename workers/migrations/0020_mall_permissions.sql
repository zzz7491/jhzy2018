-- 0020 — P24-P2B Mall Permission Infrastructure
-- 依据：P24-P2A PREFLIGHT = PASS（含 P24-P2A-REV2 修正），catalog 权威源已同步。
--
-- 范围（严格，仅此两项）：
--   1) 新增 3 条 mall 权限
--   2) 新增 6 条 role_permissions 绑定（volunteer + platform_super_admin × 3）
--   目标计数：permissions 95 → 98、role_permissions 275 → 281。
--
-- 本迁移明确不包含（禁止项）：
--   CREATE TABLE mall_products / mall_orders
--       —— 真实 Mall 表早在 0001_initial_schema.sql 已存在。
--   ALTER TABLE mall_*
--       —— 0002→0019 亦无任何 mall schema 变更；P24 不修改 mall schema。
--   points_ledger rebuild / 新增 'redeem' type
--       —— 兑换流水复用 0018 既有 type CHECK 中的 'exchange'。
--   product demo seed / price conversion
--   refund / cancel schema / admin CMS permission
--   任何兑换业务代码
--
-- 权威源：workers/scripts/permission-catalog.json（domain=mall 已同步）。
-- 0003_seed_permissions.sql 为历史 migration，不回改；P24 采用增量 migration。

-- ---------------------------------------------------------------------------
-- A) permissions delta（3 条）
--    perm_group = domain、risk_level 1=LOW / 2=MEDIUM
--    （与 0003 / 0017 / 0018 seed 格式一致）
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO permissions (code, name, perm_group, risk_level) VALUES
  ('mall.product.read', '查看团队积分商城商品与库存', 'mall', 1),
  ('mall.order.read', '查看积分兑换订单（本人订单与团队内核销）', 'mall', 1),
  ('mall.order.create', '提交积分兑换订单（扣减积分余额与商品库存）', 'mall', 2);

-- ---------------------------------------------------------------------------
-- B) role_permissions delta（6 条 = 3 权限 × 2 角色）
--    仅绑定：volunteer（兑换执行者）+ platform_super_admin（E1 持全部权限）。
--    不绑定：platform_operator / team_owner / team_admin / team_auditor。
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES
  ((SELECT id FROM roles WHERE code = 'volunteer'),           (SELECT id FROM permissions WHERE code = 'mall.product.read')),
  ((SELECT id FROM roles WHERE code = 'platform_super_admin'),(SELECT id FROM permissions WHERE code = 'mall.product.read')),
  ((SELECT id FROM roles WHERE code = 'volunteer'),           (SELECT id FROM permissions WHERE code = 'mall.order.read')),
  ((SELECT id FROM roles WHERE code = 'platform_super_admin'),(SELECT id FROM permissions WHERE code = 'mall.order.read')),
  ((SELECT id FROM roles WHERE code = 'volunteer'),           (SELECT id FROM permissions WHERE code = 'mall.order.create')),
  ((SELECT id FROM roles WHERE code = 'platform_super_admin'),(SELECT id FROM permissions WHERE code = 'mall.order.create'));
