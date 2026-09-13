// N0-F3 test bundle entry（仅 re-export，供 esbuild 打包为可执行的 ESM）。
// 此文件是测试夹具的一部分，不进入生产代码路径。
// 覆盖 N0-F3 事件权威投影 / 投递预留 / at-most-once / H6 / authorization_request_id 校验。
export { SubscriptionConsentRepository } from '../src/repository/subscription-consent';
export { NotificationDeliveryRepository } from '../src/repository/notification-delivery';
export { WeChatSubscribeAdapter } from '../src/channels/wechat/wechat-subscribe-adapter';
export { DeliveryIdentityService } from '../src/services/delivery-identity-service';
export { SubscriptionConsentService } from '../src/services/subscription-consent-service';
export {
  WECHAT_TEMPLATE_SCHEMAS,
  WECHAT_TEMPLATE_KEYS,
} from '../src/channels/wechat/wechat-template-schema';
export { FakeWeChatSubscribeProvider } from '../src/channels/wechat/wechat-provider-client';
export { generateUlid } from '../src/utils/crypto';
