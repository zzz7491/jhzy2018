// N0-E5C test bundle entry（仅 re-export，供 esbuild 打包为可执行的 ESM）。
// 此文件是测试夹具的一部分，不进入生产代码路径。
export { ActivitySignupService } from '../src/services/activity-signup-service';
export { WeChatSubscribeAdapter } from '../src/channels/wechat/wechat-subscribe-adapter';
export { DeliveryIdentityService } from '../src/services/delivery-identity-service';
export { SubscriptionConsentRepository } from '../src/repository/subscription-consent';
export { NotificationDeliveryRepository } from '../src/repository/notification-delivery';
export {
  WECHAT_TEMPLATE_SCHEMAS,
  WECHAT_TEMPLATE_KEYS,
  validateWeChatPayload,
  isWeChatFieldKey,
} from '../src/channels/wechat/wechat-template-schema';
export { FakeWeChatSubscribeProvider, mapWeChatSubscribeErrcode } from '../src/channels/wechat/wechat-provider-client';
export {
  buildSignupReviewWeChatData,
  PHRASE_APPROVED,
  PHRASE_REJECTED,
} from '../src/services/signup-review-wechat';
export { formatWeChatTime7 } from '../src/utils/wechat-time';
