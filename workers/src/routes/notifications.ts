/**
 * 站内信路由（N0-A 统一通知域 v1 —— IN_APP 闭环）。
 *
 * 端点（全部 SELF / USER_SCOPED；仅 auth required，不依赖 team 上下文）：
 *   GET  /api/v2/notifications                → 当前用户通知列表（分页，newest first）
 *   GET  /api/v2/notifications/unread-count   → 当前用户未读数
 *   GET  /api/v2/notifications/:public_id     → 当前用户单条详情
 *   POST /api/v2/notifications/:public_id/read→ 标记已读（幂等）
 *   POST /api/v2/notifications/read-all       → 全部已读（仅当前用户）
 *
 * 边界（严格遵守）：
 *   - 无 create 端点：创建是内部 domain capability（NotificationService.create），
 *     由 N0-E 业务事件调用；普通用户不能任意发通知（不是聊天系统）。
 *   - 无微信 / 短信 / 外部投递；无 template / openid / provider 字段。
 *   - 跨用户访问一律折叠为 404 NOT_FOUND（不泄露他人通知是否存在）。
 *
 * 路由注册顺序：静态路径必须在 /:public_id 之前。
 */

import { Hono } from 'hono';
import type { Env, AppVars } from '../env';
import { NotificationService } from '../services/notification-service';
import { ok } from '../utils/response';
import { authRequired } from '../utils/errors';
import { parsePagination, requireUlidParam } from '../utils/validation';

const notifications = new Hono<{ Bindings: Env; Variables: AppVars }>();

notifications.get('/', async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated || auth.userId == null) throw authRequired();

  const { page, pageSize, offset } = parsePagination(c.req.query());
  const result = await new NotificationService({
    db: c.env.DB,
    auth,
    tenant: c.get('tenant'),
  }).listMine(page, pageSize, offset);
  return ok(c, result);
});

notifications.get('/unread-count', async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated || auth.userId == null) throw authRequired();

  const result = await new NotificationService({
    db: c.env.DB,
    auth,
    tenant: c.get('tenant'),
  }).unreadCount();
  return ok(c, result);
});

notifications.post('/read-all', async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated || auth.userId == null) throw authRequired();

  const result = await new NotificationService({
    db: c.env.DB,
    auth,
    tenant: c.get('tenant'),
  }).markAllRead();
  return ok(c, result);
});

notifications.get('/:public_id', async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated || auth.userId == null) throw authRequired();
  const publicId = requireUlidParam(c.req.param('public_id'), 'public_id');

  const result = await new NotificationService({
    db: c.env.DB,
    auth,
    tenant: c.get('tenant'),
  }).getMine(publicId);
  return ok(c, result);
});

notifications.post('/:public_id/read', async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated || auth.userId == null) throw authRequired();
  const publicId = requireUlidParam(c.req.param('public_id'), 'public_id');

  const result = await new NotificationService({
    db: c.env.DB,
    auth,
    tenant: c.get('tenant'),
  }).markRead(publicId);
  return ok(c, result);
});

export default notifications;
