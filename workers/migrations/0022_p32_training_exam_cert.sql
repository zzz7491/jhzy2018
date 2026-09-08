-- =============================================================================
-- 嘉禾志愿 2.0 — D1 Migration 0022：P32 Training / Exam / Certificate
--   Public-ID + Attempt/Cert 唯一性（P32-P2 契约冻结落库）
-- =============================================================================
-- 本迁移承载 P32-P1C/P32-P1D 冻结的 schema delta（不新增权限；权限已由
-- 0003_seed_permissions.sql 预置：training.* / exam.* / certificate.* 共 12 码）。
--
-- 契约依据：
--   P32-P1  series = COMPLETE（P1A/P1B/P1C/P1D 全 PASS）
--   公开资源 key 一律 public_id（ULID）；internal numeric FK 保持 numeric。
--   exam status：1=IN_PROGRESS / 3=COMPLETED；2/4=RESERVED_NOT_USED（services 不写）。
--   attempt 唯一：UNIQUE(user_id,paper_id,attempt_no)。
--   单活跃 attempt：UNIQUE(user_id,paper_id) WHERE status IN (1,2)。
--   证书业务归属：UNIQUE(user_id,exam_paper_id) WHERE status=1（cert != qualification）。
--
-- 历史兼容原则（沿用 0017 先例）：
--   - public_id 以可空列加入 → 确定性回填 → UNIQUE index；不在 SQLite 中直接
--     ALTER ADD COLUMN NOT NULL UNIQUE。
--   - 回填格式：'01' || printf('%024d', id) —— 26 位、全为数字、落在 Crockford
--     字母表内（0-9 ⊂ [0-9A-HJKMNP-TV-Z]），确定性且唯一；新行由 Service 生成 ULID。
--   - 本域于 P32-P2 之前零写入（0001 建表后无任何 route/service/repo），表中
--     理论上无既有业务行；回填仅为防御性迁移安全网。
-- =============================================================================

PRAGMA defer_foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- A) course_lessons.public_id（TEAM_SCOPED；客户端按 lesson public_id 引用）
-- ---------------------------------------------------------------------------
ALTER TABLE course_lessons ADD COLUMN public_id TEXT;

UPDATE course_lessons
SET public_id = '01' || printf('%024d', id)
WHERE public_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_course_lessons_public_id
ON course_lessons(public_id);

-- ---------------------------------------------------------------------------
-- B) exam_questions.public_id（PLATFORM_GLOBAL 题库；admin/start 按 public_id 引用）
-- ---------------------------------------------------------------------------
ALTER TABLE exam_questions ADD COLUMN public_id TEXT;

UPDATE exam_questions
SET public_id = '01' || printf('%024d', id)
WHERE public_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_exam_questions_public_id
ON exam_questions(public_id);

-- ---------------------------------------------------------------------------
-- C) exam_sessions.public_id（TEAM_SCOPED；resume/result 按 public_id 引用）
--    同时：attempt 唯一约束 + 单活跃 attempt 部分唯一索引
-- ---------------------------------------------------------------------------
ALTER TABLE exam_sessions ADD COLUMN public_id TEXT;

UPDATE exam_sessions
SET public_id = '01' || printf('%024d', id)
WHERE public_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_exam_sessions_public_id
ON exam_sessions(public_id);

-- 既有非唯一 idx_es_user(user_id,paper_id,attempt_no) 升级为 UNIQUE（attempt 唯一）
DROP INDEX IF EXISTS idx_es_user;
CREATE UNIQUE INDEX IF NOT EXISTS uq_exam_attempt
ON exam_sessions(user_id, paper_id, attempt_no);

-- 单活跃 attempt=同一用户+同试卷至多一条 status∈{1,2}（DB 终裁，P32-P1D §B）
CREATE UNIQUE INDEX IF NOT EXISTS uq_exam_active_attempt
ON exam_sessions(user_id, paper_id)
WHERE status IN (1, 2);

-- ---------------------------------------------------------------------------
-- D) certificate_templates.public_id（PLATFORM_GLOBAL；admin/issue 按 public_id 引用）
-- ---------------------------------------------------------------------------
ALTER TABLE certificate_templates ADD COLUMN public_id TEXT;

UPDATE certificate_templates
SET public_id = '01' || printf('%024d', id)
WHERE public_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_certificate_templates_public_id
ON certificate_templates(public_id);

-- ---------------------------------------------------------------------------
-- G) certificates.exam_paper_id：业务归属（entitlement）= (user_id, exam_paper_id)
--     具体 FK 列，供 duplicate-prevention 的唯一索引使用（source_id 仍为
--     polymorphic 事件引用，保留；不替代 exam_paper_id）。
--     证书 != qualification：本列只表达 training-cert 的 paper 归属。
-- ---------------------------------------------------------------------------
ALTER TABLE certificates ADD COLUMN exam_paper_id INTEGER REFERENCES exam_papers(id) ON DELETE SET NULL;

-- 每个 (user_id, exam_paper_id) 至多一张 active training 证书（status=1）
CREATE UNIQUE INDEX IF NOT EXISTS uq_cert_user_paper
ON certificates(user_id, exam_paper_id)
WHERE status = 1 AND exam_paper_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- P32 runtime 最小播种（确定性；仅 baseline，不发明用户内容）：
--   1) 一张 training 证书模板（certificate_templates，PLATFORM_GLOBAL）
--   2) 一批 cert_trn 编号池（id_pools，供 cert_no 原子消费）
-- 注意：本域 0001 建表后从未写入；seed 用确定性 id/代码，重复执行安全。
-- ---------------------------------------------------------------------------

-- 1) training 证书模板（若不存在）
INSERT INTO certificate_templates (name, cert_type, layout, status, created_at, updated_at)
SELECT '培训证书（默认）', 'training', '{"title":"培训证书"}', 1, unixepoch(), NULL
WHERE NOT EXISTS (
  SELECT 1 FROM certificate_templates WHERE cert_type = 'training' AND status = 1
);

-- 2) cert_trn 编号池（若空：不足或已有则由 runtime/probe 补充，仅此基准 500 条）
WITH RECURSIVE seq(x) AS (
  SELECT 1 UNION ALL SELECT x + 1 FROM seq WHERE x < 500
)
INSERT INTO id_pools (pool_type, code, status, created_at)
SELECT 'cert_trn', printf('CTRN%06d', x), 0, unixepoch()
FROM seq
WHERE NOT EXISTS (SELECT 1 FROM id_pools WHERE pool_type = 'cert_trn');