-- =============================================================================
-- N0-E5B — 0037：团队公开业务联系人（TEAM_PUBLIC_CONTACT）
--
-- 冻结依据（N0-E5 §THING18_CONTRACT = TEAM_PUBLIC_CONTACT）：
--   团队管理员【主动填写】并【明确公开给活动报名者】的业务联系人信息。
--
--   TEAM_PUBLIC_CONTACT 明确【不】等于：
--     owner 私人电话 / trusted WeChat phone / identity verification phone /
--     volunteer profile phone / emergency contact / creator nickname / raw openid。
--
-- 数据分类：PUBLIC BUSINESS DATA（对报名者公开的业务联系信息），
--   与身份认证数据（phone_verifications / identity_verifications）严格分离。
--
-- 变更概要（纯增量，不改任何既有表结构语义）：
--   A. teams.public_contact_name  TEXT NULL —— 公开业务联系人名称（人类可读）
--   B. teams.public_contact_phone TEXT NULL —— 团队主动公开的业务联系电话
--
-- NULL 语义：该团队尚未配置公开业务联系人（不是"未知"、不是"继承 owner"、
--   不是"从 user profile 推导"）。展示层据 NULL 决定是否下发。
--
-- 纪律：
--   - 纯增量 ADD COLUMN；不改既有列 / 不重建无关表 / 不改 teams 既有约束。
--   - 不使用 teams.settings JSON；不新建 team_contacts 表。
--   - 不存 trusted phone / encrypted identity phone / openid / 任何 secret。
--   - 【不 backfill】：不从 owner / user profile / 任何来源回填联系方式。
--   - 不写远程 D1（本文件仅定义 schema；应用由部署流程负责）。
-- =============================================================================

PRAGMA defer_foreign_keys = ON;

-- ===== A. 公开业务联系人名称 =====
ALTER TABLE teams ADD COLUMN public_contact_name TEXT DEFAULT NULL;

-- ===== B. 公开业务联系电话 =====
ALTER TABLE teams ADD COLUMN public_contact_phone TEXT DEFAULT NULL;
