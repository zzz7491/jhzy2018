-- =============================================================================
-- 0026 — P33-R2A Community Read-Only Backend Conversion
-- =============================================================================
-- 依据：产品规则已冻结「公益社区 = 只读资料 / 内容查看中心」。
--   普通志愿者：仅可查看列表 / 详情 / 图片附件 / 分页；
--   禁止发布 / 编辑 / 评论 / 点赞 / 举报 / 投稿等任何社交写操作。
--   内容由管理员（team_admin / team_owner / platform_*）创建、维护、发布。
--
-- 范围（严格，仅此一处 RBAC 撤销）：
--   撤销 volunteer 对以下 5 条权限的绑定（role_permissions 行）：
--     content.article.self.create
--     content.article.self.update
--     content.comment.create
--     content.like.create
--     content.report.create
--
-- 纪律：
--   * 不删除 permission 定义（content.article.self.* 等定义保留，
--     仅供 platform_super_admin 仍持全权；普通 volunteer 不再持有）。
--   * 不改动 schema、不改动 routes / services / repository / frontend。
--   * 读端点（feed / detail / files）仅依赖 requireActiveTeam，不受影响。
--   * 志愿者写路由（/content/articles POST|PUT、comments、like、report）
--     使用 DB-backed requirePermission gate；撤销绑定后返回 403（forbidden），
--     无需删除路由本身。
--
-- 幂等：DELETE ... WHERE 子查询；重复执行安全（0 行影响）。
-- 权威源：workers/scripts/permission-catalog.json（domain=content 已同步，
--   本迁移为增量撤销，不回改 0003 / 0023）。
-- =============================================================================

DELETE FROM role_permissions
WHERE role_id = (SELECT id FROM roles WHERE code = 'volunteer')
  AND permission_id IN (
    SELECT id FROM permissions WHERE code IN (
      'content.article.self.create',
      'content.article.self.update',
      'content.comment.create',
      'content.like.create',
      'content.report.create'
    )
  );
