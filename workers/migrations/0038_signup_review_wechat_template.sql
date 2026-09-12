-- =============================================================================
-- N0-E5C — 0038：活动报名审核结果通知（signupReview / No.4877）注册 + 退役旧 signup / No.620
--
-- 冻结依据（N0-E5C-1 / N0-E5C-2 实现门）：
--   - 新模板：活动报名审核结果通知 / No.4877 / PGRSuLr34NVlbNE3L33-Dtqm_ad9uG-WSrZ0ew4oYs8
--     字段（顺序固定）：phrase1 审核结果 / thing2 活动名称 / thing4 活动地点 / time7 审批时间
--   - 旧 signup（No.620）：仅语义贴合但含 thing11 签到地点（无真实数据源），当前不可用；
--     退役为 status=2（message_templates.status CHECK IN (1,2)），保留历史行不删除、不改 0035。
--   - 新模板必须要求用户重新授权（一次性订阅：旧 No.620 授权与 template_id 强绑定，
--     adapter step-4 校验 template_id，不可继承）。
--
-- 安全纪律（同 0035）：
--   - 迁移不含任何明文 / Secret；template id 来自用户微信公众平台真实选定（verbatim 导入）。
--   - 历史 migration 不可修改；本迁移纯增量。
-- =============================================================================

PRAGMA defer_foreign_keys = ON;

-- ===== A. 新模板注册（active）=====
INSERT OR IGNORE INTO message_templates (code, channel, wx_template_id, title, content_tpl, status)
VALUES
  ('signupReview', 'wechat_subscribe', 'PGRSuLr34NVlbNE3L33-Dtqm_ad9uG-WSrZ0ew4oYs8', '活动报名审核结果通知', '', 1);

-- ===== B. 退役旧 signup / No.620（保留历史行，置 status=2 表示停用；不删除、不改 0035）=====
UPDATE message_templates
   SET status = 2, updated_at = (unixepoch())
 WHERE code = 'signup'
   AND channel = 'wechat_subscribe'
   AND wx_template_id = '_x9D2d6Ae7wuiewEp4XTPVsSd061O4lPaLreJdZQwM4';
