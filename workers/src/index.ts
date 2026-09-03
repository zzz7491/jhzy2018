/**
 * 嘉禾志愿 2.0 —— Worker 入口（S2-5）。
 *
 * S2-5 在 S2-4 基础设施上新增 /api/v2 统一 API 层：
 * 统一响应/错误处理/RequestID/校验/AuthContext/RBAC 骨架/Tenant Scope/Repository。
 * 仍为最小只读 API；业务写操作、真实鉴权、权限目录解冻均留待后续阶段。
 */

import { createApp } from './app';

export default createApp();
