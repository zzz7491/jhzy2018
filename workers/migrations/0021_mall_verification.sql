-- 0021 — P25-P2A Mall Verification Infrastructure
-- 依据：P25-P0 DISCOVERY = PASS、P25-P1 DESIGN = PASS（含 REV1/REV2 碰撞/失败语义冻结）。
-- 权威源：workers/scripts/permission-catalog.json（domain=mall 已同步）。
--
-- 范围（严格，仅此两项）：
--   1) mall_orders 增加 exchange_code（公开领取/核销凭证，与内部 verify_code 严格分离）
--   2) 新增 1 条 mall 权限 + 3 条 role_permissions 绑定
--       （team_owner + team_admin + platform_super_admin）
--   目标计数：permissions 98 → 99、role_permissions 281 → 284。
--
-- 本迁移明确不包含（禁止项）：
--   CREATE/REBUILD mall_orders / mall_products
--        —— 真实 Mall 表早在 0001_initial_schema.sql 已存在。
--   修改 status CHECK（1/2/3/4 语义冻结：1=待领取/待核销、2=已领取/已核销、3/4=RESERVED）
--   回填旧订单（旧订单 exchange_code = NULL，UNIQUE 索引允许多个 NULL）
--   新增 expiry / refund / cancel 字段或语义
--   任何兑换/核销业务代码
--
-- 设计约束（P25-P1-REV2 冻结）：
--   exchange_code 由业务层在兑换成功时生成（非 NULL），UNIQUE 索引作最终兜底；
--   若 batch 因极低概率 UNIQUE 冲突失败，依赖原子回滚 + 客户端同 order_no 重试恢复，
--   生产代码不解析 D1 error message。

-- ---------------------------------------------------------------------------
-- A) schema delta（SQLite/D1 合法：先 ADD COLUMN，再 CREATE UNIQUE INDEX）
--    SQLite 不支持 `ADD COLUMN ... UNIQUE`，必须分步。
-- ---------------------------------------------------------------------------
ALTER TABLE mall_orders
  ADD COLUMN exchange_code TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mall_orders_exchange_code
  ON mall_orders(exchange_code);

-- ---------------------------------------------------------------------------
-- B) permissions delta（1 条）
--    perm_group = domain、risk_level 1=LOW / 2=MEDIUM
--    （与 0003 / 0017 / 0018 / 0020 seed 格式一致；verify 仅翻转订单生命周期、
--      不动积分/库存/身份，风险 ≤ mall.order.create，故取 MEDIUM/2）
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO permissions (code, name, perm_group, risk_level) VALUES
  ('mall.order.verify', '团队内核销积分兑换订单（标记已领取/已核销，仅翻转订单状态）', 'mall', 2);

-- ---------------------------------------------------------------------------
-- C) role_permissions delta（3 条 = 1 权限 × 3 角色）
--    仅绑定：team_owner + team_admin + platform_super_admin（均需 active team 上下文）。
--    不绑定：volunteer（用户要求：志愿者不应核销他人订单）、
--            platform_operator / team_auditor / team_member。
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES
  ((SELECT id FROM roles WHERE code = 'team_owner'),          (SELECT id FROM permissions WHERE code = 'mall.order.verify')),
  ((SELECT id FROM roles WHERE code = 'team_admin'),          (SELECT id FROM permissions WHERE code = 'mall.order.verify')),
  ((SELECT id FROM roles WHERE code = 'platform_super_admin'),(SELECT id FROM permissions WHERE code = 'mall.order.verify'));
