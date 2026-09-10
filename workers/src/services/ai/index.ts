/**
 * 嘉禾 AI V1 barrel（P36-C1 foundation + P36-C2 context/backend）。
 *
 * 导出：provider-neutral 接口 / adapter / 工厂 / 版本化 prompt /
 *       业务数据块组装（context）/ 隐私 guard / 输入规范 / usage 记录 / 后端服务。
 *
 * 仍【不含】：conversation routes / frontend / runtime rate limiter / RAG / Agent / tool calling。
 */

export * from './provider';
export * from './http-chat-provider';
export * from './factory';
export * from './prompts/volunteer-assist.v1';
export * from './privacy';
export * from './input';
export * from './data-block';
export * from './usage';
export * from './service';
