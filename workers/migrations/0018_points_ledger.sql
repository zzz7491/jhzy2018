-- 0018 — P23 Points Ledger
-- 依据：P23-DESIGN REV1–REV7 冻结 + disposable DB probe 实测通过。
--
-- 单位冻结：本表既有 INTEGER 字段（amount / balance_after /
-- points_accounts.balance / total_earned / total_spent）正式定义为
-- P23 units（100 units = 1.00 point），与 P22 points_awarded_units 同 scale。
-- 常量：POINTS_UNITS_PER_POINT = 100。
--
-- 部署前置（安全规则）：若目标库 points_ledger / points_accounts 非空
-- 且旧 scale 无权威定义，必须 BLOCK（禁止把未知旧数据 reinterpret 为 units）。
-- 本地/生产当前均为零行，可直接应用。
--
-- 本迁移不自动发放任何历史积分：历史 ServiceRecord 的 points_revision
-- 统一保持 0（由未来独立 reconciliation 阶段显式处理，不在此处 backfill）。

-- ============================================================
-- 1) service_records：新增 points_revision（TRUE mutation gate）
--    0 = legacy / 尚未进入 P23 realtime points pipeline
--    >=1 = 每次真实成功且影响积分 entitlement 的 SR mutation 计数
--    所有推进只允许 +1（settlement INSERT 显式置 1；adjust/revoke UPDATE +1），
--    客户端不可设置；不进入 API 投影。
-- ============================================================
ALTER TABLE service_records
  ADD COLUMN points_revision INTEGER NOT NULL DEFAULT 0
  CHECK (points_revision >= 0);

-- ============================================================
-- 2) points_accounts：新增 total_debits
--    语义：total_spent = 未来商城消费专用；
--          service reversal / 负向调整只累计 total_debits，
--          绝不污染 total_spent。
--    恒等式：balance == total_earned - total_debits - total_spent。
--    last_ledger_id 保留原值（dormant legacy 字段，P23 v1 不维护）。
-- ============================================================
ALTER TABLE points_accounts
  ADD COLUMN total_debits INTEGER NOT NULL DEFAULT 0;

-- ============================================================
-- 3) points_ledger：type CHECK 扩展（仅新增 'service'，不新增 'mall'）
--    SQLite 不支持 ALTER CHECK，按 disposable probe 已验证的
--    rename → recreate → copy → drop → 重建索引 范式执行。
--    无任何表 FK 引用 points_ledger（已核实），RENAME 不改写其它表 FK target。
--    id 为 INTEGER PRIMARY KEY（rowid 别名），显式搬运 id 列保持原 ID 连续。
--    旧索引在旧表存在期间占用名称，必须先 DROP old 再重建同名索引。
-- ============================================================
ALTER TABLE points_ledger RENAME TO _points_ledger_old;

CREATE TABLE points_ledger (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  direction     INTEGER NOT NULL CHECK (direction IN (1,2)),
  amount        INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('activity','training','exam','exchange','manual','reward','service')),
  source_type   TEXT,
  source_id     INTEGER,
  request_id    TEXT NOT NULL UNIQUE,                       -- 幂等键
  remark        TEXT,
  operator_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO points_ledger (
  id, user_id, direction, amount, balance_after, type,
  source_type, source_id, request_id, remark, operator_id, created_at
)
SELECT
  id, user_id, direction, amount, balance_after, type,
  source_type, source_id, request_id, remark, operator_id, created_at
FROM _points_ledger_old;

DROP TABLE _points_ledger_old;

-- 旧表已 DROP，索引名称已释放，此处重建同名索引（与 0001 定义一致）
CREATE INDEX IF NOT EXISTS idx_pl_user   ON points_ledger(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pl_source ON points_ledger(source_type, source_id);

-- ============================================================
-- 4) Permission delta：新增唯一 SELF 权限 points.account.read
--    domain=points / resource=account / action=read / USER scope / LOW。
--    绑定：volunteer + platform_super_admin（不给 team_owner/admin/auditor）。
--    目标计数：permissions 94→95、role_permissions 273→275。
--    （与 catalog meta 同步更新；与 0003/0017 seed 格式一致。）
-- ============================================================
INSERT OR IGNORE INTO permissions (code, name, perm_group, risk_level) VALUES
  ('points.account.read', '查看本人积分账户与流水', 'points', 1);

INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES
  ((SELECT id FROM roles WHERE code = 'volunteer'),           (SELECT id FROM permissions WHERE code = 'points.account.read')),
  ((SELECT id FROM roles WHERE code = 'platform_super_admin'),(SELECT id FROM permissions WHERE code = 'points.account.read'));
