// N0-D test bundle entry（仅 re-export，供 esbuild 打包为可执行的 ESM）。
// 此文件是测试夹具的一部分，不进入生产代码路径。
export { WeChatSubscribeAdapter } from '../src/channels/wechat/wechat-subscribe-adapter';
export { DeliveryIdentityService, getDeliveryIdentityKey } from '../src/services/delivery-identity-service';
export { SubscriptionConsentRepository } from '../src/repository/subscription-consent';
export { NotificationDeliveryRepository } from '../src/repository/notification-delivery';
export {
  WECHAT_TEMPLATE_SCHEMAS,
  WECHAT_TEMPLATE_KEYS,
  WECHAT_FIELD_PREFIXES,
  validateWeChatPayload,
  isWeChatFieldKey,
} from '../src/channels/wechat/wechat-template-schema';
export {
  FakeWeChatSubscribeProvider,
  mapWeChatSubscribeErrcode,
} from '../src/channels/wechat/wechat-provider-client';
export { BaseRepository } from '../src/repository/base';
export type {
  WeChatSendResult,
  WeChatSendParams,
  WeChatSendStatus,
} from '../src/channels/wechat/wechat-subscribe-adapter';
