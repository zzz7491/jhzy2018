-- P37-C1：数据运营 analytics 后端专用索引（仅此一个索引，无新表/新列/汇总表）。
--
-- 背景：P37 V1 运营概览（TEAM + PLATFORM scope）需按 team 维度聚合多张既有表。
-- team_members 现有索引为 idx_tm_user(user_id, join_status)（按 user 维度），
-- 无法服务「给定 team_id → 统计成员」的团队级聚合；本迁移补齐 team-led 维度索引。
--
-- 范围纪律（P37-C1 §3 / §16）：
--   - 仅允许 CREATE INDEX IF NOT EXISTS idx_tm_team ON team_members(team_id, join_status)；
--   - 禁止新 table / 新 column / summary table / materialized view / 其它 speculative 索引；
--   - 不动 RBAC seeds、不动其它表 DDL、不写权限目录。

CREATE INDEX IF NOT EXISTS idx_tm_team
  ON team_members(team_id, join_status);
