-- P0-C：志愿者资格（QUALIFICATION）派生标记 —— SCHEMA-ONLY（无启发式 backfill）。
--
-- 设计冻结修正（P0-C MARKER MIGRATION FIX）：
--   - 不新增 qualification_status 表/列（资格为实时派生事实）。
--   - courses.purpose / exam_papers.purpose 以「无歧义显式标识」标记初始必训课程与资格试卷。
--   - 本迁移【只做 schema】：新增列 + 索引 + 唯一性约束；**不自动 backfill 任何既有行**。
--       · required=1  ≠  INITIAL_VOLUNTEER（禁止由 required / title / sort / min-max id 推断）。
--       · course_id   ≠  唯一 qualification exam（禁止把课程下全部试卷批量标记）。
--   - INITIAL_VOLUNTEER 标记由 admin / configuration 显式指定（后续环节），
--     测试由 deterministic fixture 显式创建 1 个 INITIAL_VOLUNTEER course + exam。
--   - pass_score = 90 仅适用于 purpose='INITIAL_VOLUNTEER' 的资格试卷，且必须是「真实持久化事实」：
--       · backend authority 写入路径（ExamRepository.adminCreatePaper / adminUpdatePaper）在标记
--         INITIAL_VOLUNTEER 时强制 pass_score = 90，并阻止后续把已标记试卷改成其它值；
--       · DB 层触发器（见文件末尾）拒绝任何让 purpose='INITIAL_VOLUNTEER' 与 pass_score<>90 共存的
--         写入（backend / admin / config / 直连 DB 一并覆盖），使「数据库事实」恒为 90；
--       · 全局默认 60 与普通（非 INITIAL_VOLUNTEER）试卷完全不受影响。
--
-- 安全：fresh local D1 中 purpose 全为默认 ''，唯一索引在无 INITIAL 行时创建恒成功。

-- ===== courses.purpose（SCHEMA）=====
ALTER TABLE courses
  ADD COLUMN purpose TEXT NOT NULL DEFAULT '' CHECK (purpose IN ('', 'INITIAL_VOLUNTEER'));
CREATE INDEX IF NOT EXISTS idx_courses_purpose ON courses (purpose);

-- ===== exam_papers.purpose（SCHEMA）=====
ALTER TABLE exam_papers
  ADD COLUMN purpose TEXT NOT NULL DEFAULT '' CHECK (purpose IN ('', 'INITIAL_VOLUNTEER'));
CREATE INDEX IF NOT EXISTS idx_exam_papers_purpose ON exam_papers (purpose);

-- ===== 唯一性（仅约束 active row；软删除行不参与）=====
-- 有效数据中至多存在 1 个 INITIAL_VOLUNTEER 课程 / 1 张 INITIAL_VOLUNTEER 试卷。
-- （partial UNIQUE：被索引列在谓词内恒为 'INITIAL_VOLUNTEER'，故等价于「至多一行」。）
CREATE UNIQUE INDEX IF NOT EXISTS uq_courses_initial_volunteer
  ON courses (purpose) WHERE purpose = 'INITIAL_VOLUNTEER' AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_exam_papers_initial_volunteer
  ON exam_papers (purpose) WHERE purpose = 'INITIAL_VOLUNTEER' AND deleted_at IS NULL;

-- 说明：本迁移不含任何 UPDATE / backfill / pass_score 批量写入。

-- ===== 数据不变量（DB 层终裁）：INITIAL_VOLUNTEER 试卷的 pass_score 必须恒为 90 =====
-- SQLite 的 BEFORE 触发器无法改写 NEW.*，故采用「拒绝不一致写入」语义：
-- 任何把 purpose='INITIAL_VOLUNTEER' 与 pass_score<>90 同时持久化的 INSERT / UPDATE 均被
-- RAISE(ABORT) 拒绝。这样即便绕过 backend（直连 DB / 未来 config 通道），数据库事实也不会
-- 出现「标记为资格试卷却带 60 分及格线而运行时偷偷按 90」的不可审计状态。
-- 非 INITIAL_VOLUNTEER 行不匹配 WHEN 谓词，普通试卷与全局默认 60 不受影响。
CREATE TRIGGER IF NOT EXISTS trg_exam_papers_initial_pass_score_ins
BEFORE INSERT ON exam_papers
FOR EACH ROW
WHEN NEW.purpose = 'INITIAL_VOLUNTEER' AND NEW.pass_score <> 90
BEGIN
  SELECT RAISE(ABORT, 'INITIAL_VOLUNTEER exam_papers.pass_score must be 90');
END;

CREATE TRIGGER IF NOT EXISTS trg_exam_papers_initial_pass_score_upd
BEFORE UPDATE ON exam_papers
FOR EACH ROW
WHEN NEW.purpose = 'INITIAL_VOLUNTEER' AND NEW.pass_score <> 90
BEGIN
  SELECT RAISE(ABORT, 'INITIAL_VOLUNTEER exam_papers.pass_score must be 90');
END;
