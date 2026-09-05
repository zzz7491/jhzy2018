-- =============================================================================
-- 嘉禾志愿 2.0 —— D1 Migration 0016：Activity Signup × Form Engine Link（P21）
-- =============================================================================
-- 范围：
--   activity_signups.form_submission_id —— signup ⇢ 已 submitted 表单证据（1:1；NULL=legacy/无表单）
--   form_bindings.consume_policy        —— consumer 消费策略：0 none / 1 optional(默认) / 2 required
-- 约定：WITH-logic (0001/0015 同款)；SQLite ALTER ADD COLUMN 支持 REFERENCES 与 CHECK；
--       partial UNIQUE 保证 form_submission_id 至多被一条 signup 绑定。
-- =============================================================================

PRAGMA defer_foreign_keys = ON;

-- signup 绑定 P20 form submission（仅接受 status=2 已提交证据；写入由 service 原子谓词校验）
ALTER TABLE activity_signups ADD COLUMN form_submission_id INTEGER REFERENCES form_submissions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_signup_form_sub ON activity_signups(form_submission_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_signup_form_sub ON activity_signups(form_submission_id)
  WHERE form_submission_id IS NOT NULL;

-- form_bindings 消费策略（0 none / 1 optional / 2 required；默认 optional，防历史 binding 被意外强制）
ALTER TABLE form_bindings ADD COLUMN consume_policy INTEGER NOT NULL DEFAULT 1
  CHECK (consume_policy IN (0,1,2));