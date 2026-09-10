/**
 * 嘉禾 AI V1 基础层 barrel（P36-C1）。
 *
 * 导出：provider-neutral 接口 / adapter / 工厂 / 版本化 prompt。
 * 注意：本阶段【不含】context builder / AI service / conversation routes / frontend。
 */

export * from './provider';
export * from './http-chat-provider';
export * from './factory';
export * from './prompts/volunteer-assist.v1';
