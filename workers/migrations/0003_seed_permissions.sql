-- =============================================================================
-- 嘉禾志愿 2.0 —— D1 Migration 0003：Permission Seed（S2-6e）
-- =============================================================================
-- GENERATED FROM:
--   workers/scripts/permission-catalog.json
--
-- DO NOT EDIT BY HAND.
-- 本文件由 scripts/gen_permission_seed.mjs 单向机械生成；
-- 任何修改必须改 JSON 事实源后重新生成，保证 Git diff 稳定。
--
-- 列映射（以 0002_rbac_structure.sql 真实 Schema 为准，未新增任何列）：
--   permissions.code       <- p.code
--   permissions.name       <- p.description (NOT NULL, 中文说明)
--   permissions.perm_group <- p.domain
--   permissions.risk_level <- p.riskLevel (1=LOW / 2=MEDIUM / 3=HIGH)
--   role_permissions.role_id      <- (SELECT id FROM roles WHERE code=role)
--   role_permissions.permission_id<- (SELECT id FROM permissions WHERE code=perm)
--
-- EXPECTED_PERMISSIONS = 87
-- EXPECTED_ROLE_PERMISSION_ROWS = 247
-- =============================================================================

PRAGMA defer_foreign_keys = ON;

-- permissions：来自 JSON，按 code ASC
INSERT INTO permissions (code, name, perm_group, risk_level) VALUES
  ('account.certification.review', '志愿者实名认证审核', 'account', 3),
  ('account.identity.bind', '绑定微信/手机号等身份凭证', 'account', 2),
  ('account.identity.unbind', '解绑身份凭证', 'account', 2),
  ('account.profile.update', '更新个人档案', 'account', 1),
  ('account.profile.view', '查看团队成员/他人档案（本人查看走归属规则，不需此权限）', 'account', 1),
  ('account.status.update', '账号封禁/启用', 'account', 3),
  ('activity.activity.cancel', '取消活动', 'activity', 2),
  ('activity.activity.create', '创建活动', 'activity', 2),
  ('activity.activity.delete', '删除活动（软删）', 'activity', 3),
  ('activity.activity.publish', '发布/下架活动', 'activity', 3),
  ('activity.activity.update', '编辑活动', 'activity', 2),
  ('activity.category.manage', '活动分类管理', 'activity', 2),
  ('ai.assist.use', '使用 AI 助手', 'ai', 1),
  ('ai.usage.view', '查看 AI 用量', 'ai', 1),
  ('analytics.platform.view', '查看全平台统计', 'analytics', 2),
  ('analytics.team.view', '查看团队统计', 'analytics', 1),
  ('attendance.anomaly.handle', '处理考勤异常', 'attendance', 3),
  ('attendance.record.checkin', '签到（本人）', 'attendance', 1),
  ('attendance.record.checkout', '签退（本人）', 'attendance', 1),
  ('attendance.record.force', '强制签退/代签', 'attendance', 3),
  ('attendance.record.review', '考勤记录审核', 'attendance', 2),
  ('audit.log.view', '查看操作审计日志', 'audit', 3),
  ('audit.security.handle', '处理安全事件', 'audit', 3),
  ('audit.security.view', '查看安全事件', 'audit', 3),
  ('audit.sensitive.access', '访问/解密敏感数据（实名/手机/身份证）', 'audit', 3),
  ('audit.sensitive.view', '查看敏感数据访问日志', 'audit', 3),
  ('certificate.certificate.issue', '发放证书', 'certificate', 3),
  ('certificate.certificate.revoke', '撤销证书', 'certificate', 3),
  ('certificate.certificate.verify', '公开验真（凭编号/验证码）', 'certificate', 1),
  ('certificate.certificate.view', '查看团队证书（本人查看走归属规则）', 'certificate', 1),
  ('certificate.template.manage', '证书模板管理', 'certificate', 3),
  ('content.article.audit', '内容审核', 'content', 3),
  ('content.article.create', '发布内容（公告/故事/知识）', 'content', 2),
  ('content.article.delete', '删除内容', 'content', 3),
  ('content.article.publish', '发布/上下架内容', 'content', 2),
  ('content.article.update', '编辑内容', 'content', 2),
  ('content.category.manage', '内容分类管理', 'content', 2),
  ('content.comment.create', '评论（本人）', 'content', 1),
  ('content.like.create', '点赞（本人）', 'content', 1),
  ('content.report.create', '举报内容（本人）', 'content', 1),
  ('exam.exam.grade', '阅卷/成绩审核', 'exam', 2),
  ('exam.exam.take', '参加考试（本人）', 'exam', 1),
  ('exam.paper.manage', '试卷管理', 'exam', 2),
  ('exam.question.manage', '题库管理', 'exam', 2),
  ('file.file.delete', '删除文件', 'file', 2),
  ('file.file.upload', '上传文件（本人/团队）', 'file', 1),
  ('file.file.view', '查看文件', 'file', 1),
  ('honor.honor.award', '授予荣誉/徽章', 'honor', 2),
  ('honor.honor.manage', '荣誉/勋章管理', 'honor', 2),
  ('notification.notification.send', '发送团队通知', 'notification', 2),
  ('notification.notification.view', '查看通知（本人）', 'notification', 1),
  ('notification.template.manage', '通知模板管理', 'notification', 2),
  ('participation.assignment.cancel', '取消本人的参与分配', 'participation', 1),
  ('participation.assignment.create', '本人报名参与分配（报名+场次+可选时段）', 'participation', 1),
  ('participation.assignment.manage', '团队代分配/管理成员的参与分配', 'participation', 2),
  ('participation.assignment.update', '修改本人参与分配的岗位（不重建行）', 'participation', 1),
  ('points.growth.manage', '成长规则管理', 'points', 3),
  ('points.ledger.adjust', '手工调整积分', 'points', 3),
  ('points.ledger.view', '查看积分流水（本人/团队）', 'points', 2),
  ('points.level.view', '查看等级体系', 'points', 1),
  ('rbac.catalog.view', '查看权限目录', 'rbac', 1),
  ('rbac.permission.assign', '编辑角色-权限绑定（授权）', 'rbac', 3),
  ('rbac.role.assign.platform', '分配平台级角色（仅 super_admin）', 'rbac', 3),
  ('rbac.role.assign.team', '分配团队级角色（team_admin/auditor/volunteer）', 'rbac', 3),
  ('rbac.role.revoke.platform', '撤销平台级角色', 'rbac', 3),
  ('rbac.role.revoke.team', '撤销团队级角色', 'rbac', 3),
  ('service.record.adjust', '手工修正服务时长', 'service', 3),
  ('service.record.review', '服务时长审核', 'service', 2),
  ('signup.signup.cancel', '取消自己的报名', 'signup', 1),
  ('signup.signup.create', '报名活动', 'signup', 1),
  ('signup.signup.review', '审核活动报名', 'signup', 3),
  ('system.backup.manage', '数据备份/导出', 'system', 3),
  ('system.config.manage', '平台级配置', 'system', 3),
  ('system.idpool.manage', 'ID 池管理（证书编号等）', 'system', 3),
  ('team.member.ban', '停用/恢复团队成员', 'team', 3),
  ('team.member.invite', '邀请成员加入团队', 'team', 2),
  ('team.member.remove', '移除团队成员', 'team', 3),
  ('team.member.role.update', '调整成员团队角色', 'team', 3),
  ('team.settings.update', '修改团队设置', 'team', 2),
  ('team.team.create', '创建团队', 'team', 3),
  ('team.team.disband', '解散团队', 'team', 3),
  ('team.team.update', '更新团队资料', 'team', 2),
  ('training.course.manage', '课程与课时管理', 'training', 2),
  ('training.enrollment.enroll', '报名学习课程（本人）', 'training', 1),
  ('training.learning.learn', '学习课程/记录进度（本人）', 'training', 1),
  ('welfare.report.review', '审核公益上报', 'welfare', 3),
  ('welfare.report.submit', '提交随手公益/公益内容（本人）', 'welfare', 1);

-- role_permissions：六角色显式绑定（禁止 *；super_admin 显式关联全部权限）
-- role: platform_operator (26 bindings)
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_operator'), (SELECT id FROM permissions WHERE code = 'activity.category.manage'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_operator'), (SELECT id FROM permissions WHERE code = 'ai.assist.use'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_operator'), (SELECT id FROM permissions WHERE code = 'ai.usage.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_operator'), (SELECT id FROM permissions WHERE code = 'analytics.platform.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_operator'), (SELECT id FROM permissions WHERE code = 'audit.log.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_operator'), (SELECT id FROM permissions WHERE code = 'audit.security.handle'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_operator'), (SELECT id FROM permissions WHERE code = 'audit.security.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_operator'), (SELECT id FROM permissions WHERE code = 'certificate.certificate.verify'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_operator'), (SELECT id FROM permissions WHERE code = 'certificate.template.manage'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_operator'), (SELECT id FROM permissions WHERE code = 'content.article.audit'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_operator'), (SELECT id FROM permissions WHERE code = 'content.article.create'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_operator'), (SELECT id FROM permissions WHERE code = 'content.article.delete'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_operator'), (SELECT id FROM permissions WHERE code = 'content.article.publish'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_operator'), (SELECT id FROM permissions WHERE code = 'content.article.update'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_operator'), (SELECT id FROM permissions WHERE code = 'content.category.manage'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_operator'), (SELECT id FROM permissions WHERE code = 'exam.question.manage'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_operator'), (SELECT id FROM permissions WHERE code = 'file.file.delete'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_operator'), (SELECT id FROM permissions WHERE code = 'file.file.upload'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_operator'), (SELECT id FROM permissions WHERE code = 'file.file.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_operator'), (SELECT id FROM permissions WHERE code = 'notification.notification.send'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_operator'), (SELECT id FROM permissions WHERE code = 'notification.template.manage'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_operator'), (SELECT id FROM permissions WHERE code = 'points.growth.manage'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_operator'), (SELECT id FROM permissions WHERE code = 'points.level.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_operator'), (SELECT id FROM permissions WHERE code = 'rbac.catalog.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_operator'), (SELECT id FROM permissions WHERE code = 'system.idpool.manage'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_operator'), (SELECT id FROM permissions WHERE code = 'team.team.create'));

-- role: platform_super_admin (87 bindings)
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'account.certification.review'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'account.identity.bind'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'account.identity.unbind'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'account.profile.update'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'account.profile.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'account.status.update'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'activity.activity.cancel'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'activity.activity.create'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'activity.activity.delete'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'activity.activity.publish'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'activity.activity.update'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'activity.category.manage'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'ai.assist.use'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'ai.usage.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'analytics.platform.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'analytics.team.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'attendance.anomaly.handle'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'attendance.record.checkin'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'attendance.record.checkout'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'attendance.record.force'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'attendance.record.review'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'audit.log.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'audit.security.handle'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'audit.security.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'audit.sensitive.access'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'audit.sensitive.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'certificate.certificate.issue'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'certificate.certificate.revoke'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'certificate.certificate.verify'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'certificate.certificate.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'certificate.template.manage'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'content.article.audit'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'content.article.create'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'content.article.delete'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'content.article.publish'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'content.article.update'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'content.category.manage'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'content.comment.create'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'content.like.create'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'content.report.create'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'exam.exam.grade'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'exam.exam.take'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'exam.paper.manage'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'exam.question.manage'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'file.file.delete'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'file.file.upload'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'file.file.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'honor.honor.award'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'honor.honor.manage'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'notification.notification.send'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'notification.notification.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'notification.template.manage'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'participation.assignment.cancel'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'participation.assignment.create'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'participation.assignment.manage'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'participation.assignment.update'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'points.growth.manage'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'points.ledger.adjust'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'points.ledger.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'points.level.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'rbac.catalog.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'rbac.permission.assign'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'rbac.role.assign.platform'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'rbac.role.assign.team'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'rbac.role.revoke.platform'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'rbac.role.revoke.team'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'service.record.adjust'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'service.record.review'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'signup.signup.cancel'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'signup.signup.create'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'signup.signup.review'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'system.backup.manage'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'system.config.manage'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'system.idpool.manage'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'team.member.ban'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'team.member.invite'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'team.member.remove'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'team.member.role.update'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'team.settings.update'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'team.team.create'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'team.team.disband'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'team.team.update'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'training.course.manage'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'training.enrollment.enroll'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'training.learning.learn'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'welfare.report.review'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'platform_super_admin'), (SELECT id FROM permissions WHERE code = 'welfare.report.submit'));

-- role: team_admin (44 bindings)
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'account.certification.review'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'account.profile.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'activity.activity.cancel'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'activity.activity.create'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'activity.activity.publish'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'activity.activity.update'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'ai.assist.use'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'analytics.team.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'attendance.anomaly.handle'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'attendance.record.force'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'attendance.record.review'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'audit.log.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'audit.security.handle'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'audit.security.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'certificate.certificate.issue'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'certificate.certificate.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'content.article.audit'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'content.article.create'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'content.article.delete'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'content.article.publish'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'content.article.update'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'exam.exam.grade'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'exam.paper.manage'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'file.file.delete'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'file.file.upload'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'file.file.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'honor.honor.award'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'honor.honor.manage'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'notification.notification.send'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'participation.assignment.manage'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'points.ledger.adjust'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'points.ledger.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'points.level.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'rbac.catalog.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'service.record.adjust'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'service.record.review'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'signup.signup.review'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'team.member.ban'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'team.member.invite'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'team.member.remove'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'team.settings.update'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'team.team.update'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'training.course.manage'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_admin'), (SELECT id FROM permissions WHERE code = 'welfare.report.review'));

-- role: team_auditor (19 bindings)
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_auditor'), (SELECT id FROM permissions WHERE code = 'account.certification.review'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_auditor'), (SELECT id FROM permissions WHERE code = 'account.profile.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_auditor'), (SELECT id FROM permissions WHERE code = 'ai.assist.use'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_auditor'), (SELECT id FROM permissions WHERE code = 'analytics.team.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_auditor'), (SELECT id FROM permissions WHERE code = 'attendance.record.review'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_auditor'), (SELECT id FROM permissions WHERE code = 'audit.log.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_auditor'), (SELECT id FROM permissions WHERE code = 'audit.security.handle'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_auditor'), (SELECT id FROM permissions WHERE code = 'audit.security.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_auditor'), (SELECT id FROM permissions WHERE code = 'certificate.certificate.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_auditor'), (SELECT id FROM permissions WHERE code = 'content.article.audit'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_auditor'), (SELECT id FROM permissions WHERE code = 'exam.exam.grade'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_auditor'), (SELECT id FROM permissions WHERE code = 'file.file.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_auditor'), (SELECT id FROM permissions WHERE code = 'notification.notification.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_auditor'), (SELECT id FROM permissions WHERE code = 'points.ledger.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_auditor'), (SELECT id FROM permissions WHERE code = 'points.level.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_auditor'), (SELECT id FROM permissions WHERE code = 'rbac.catalog.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_auditor'), (SELECT id FROM permissions WHERE code = 'service.record.review'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_auditor'), (SELECT id FROM permissions WHERE code = 'signup.signup.review'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_auditor'), (SELECT id FROM permissions WHERE code = 'welfare.report.review'));

-- role: team_owner (49 bindings)
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'account.certification.review'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'account.profile.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'activity.activity.cancel'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'activity.activity.create'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'activity.activity.delete'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'activity.activity.publish'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'activity.activity.update'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'ai.assist.use'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'analytics.team.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'attendance.anomaly.handle'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'attendance.record.force'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'attendance.record.review'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'audit.log.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'audit.security.handle'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'audit.security.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'certificate.certificate.issue'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'certificate.certificate.revoke'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'certificate.certificate.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'content.article.audit'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'content.article.create'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'content.article.delete'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'content.article.publish'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'content.article.update'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'exam.exam.grade'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'exam.paper.manage'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'file.file.delete'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'file.file.upload'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'file.file.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'honor.honor.award'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'honor.honor.manage'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'notification.notification.send'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'participation.assignment.manage'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'points.ledger.adjust'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'points.ledger.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'points.level.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'rbac.catalog.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'rbac.role.assign.team'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'rbac.role.revoke.team'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'service.record.adjust'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'service.record.review'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'signup.signup.review'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'team.member.ban'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'team.member.invite'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'team.member.remove'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'team.member.role.update'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'team.settings.update'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'team.team.update'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'training.course.manage'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'team_owner'), (SELECT id FROM permissions WHERE code = 'welfare.report.review'));

-- role: volunteer (22 bindings)
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'volunteer'), (SELECT id FROM permissions WHERE code = 'account.identity.bind'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'volunteer'), (SELECT id FROM permissions WHERE code = 'account.identity.unbind'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'volunteer'), (SELECT id FROM permissions WHERE code = 'account.profile.update'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'volunteer'), (SELECT id FROM permissions WHERE code = 'ai.assist.use'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'volunteer'), (SELECT id FROM permissions WHERE code = 'attendance.record.checkin'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'volunteer'), (SELECT id FROM permissions WHERE code = 'attendance.record.checkout'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'volunteer'), (SELECT id FROM permissions WHERE code = 'content.comment.create'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'volunteer'), (SELECT id FROM permissions WHERE code = 'content.like.create'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'volunteer'), (SELECT id FROM permissions WHERE code = 'content.report.create'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'volunteer'), (SELECT id FROM permissions WHERE code = 'exam.exam.take'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'volunteer'), (SELECT id FROM permissions WHERE code = 'file.file.upload'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'volunteer'), (SELECT id FROM permissions WHERE code = 'file.file.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'volunteer'), (SELECT id FROM permissions WHERE code = 'notification.notification.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'volunteer'), (SELECT id FROM permissions WHERE code = 'participation.assignment.cancel'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'volunteer'), (SELECT id FROM permissions WHERE code = 'participation.assignment.create'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'volunteer'), (SELECT id FROM permissions WHERE code = 'participation.assignment.update'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'volunteer'), (SELECT id FROM permissions WHERE code = 'points.level.view'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'volunteer'), (SELECT id FROM permissions WHERE code = 'signup.signup.cancel'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'volunteer'), (SELECT id FROM permissions WHERE code = 'signup.signup.create'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'volunteer'), (SELECT id FROM permissions WHERE code = 'training.enrollment.enroll'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'volunteer'), (SELECT id FROM permissions WHERE code = 'training.learning.learn'));
INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code = 'volunteer'), (SELECT id FROM permissions WHERE code = 'welfare.report.submit'));
