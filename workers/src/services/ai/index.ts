/**
 * 嘉禾 AI V1 barrel（P36-C1 foundation + P36-C2 context/backend + P36-C3-1 rate-limit）。
 *
 * 导出：provider-neutral 接口 / adapter / 工厂 / 版本化 prompt /
 *       业务数据块组装（context）/ 输入规范 / usage 记录 / 后端服务 /
 *       best-effort rate-limit foundation / conversation orchestration service。
 *
 * 仍【不含】：conversation routes / frontend / RAG / Agent / tool calling。
 * （conversation 持久化位于 repository 层：src/repository/ai-conversation.ts，不经本 barrel 导出。）
 *
 * 隐私 guard 为共享纯工具（P36-C3-1A）：`src/utils/ai-privacy.ts`。repository 与 services 均从
 * 该处导入，本 barrel 【不】再导出它——避免出现第二份导出路径 / 兼容 shim。
 */

export * from './provider';
export * from './http-chat-provider';
export * from './factory';
export * from './prompts/volunteer-assist.v1';
export * from './input';
export * from './data-block';
export * from './usage';
export * from './service';
export * from './rate-limit';
export * from './conversation-service';
