export {
  authorizeWechatIlink,
  type WechatAuthorizationOptions,
  type WechatAuthorizationResult,
} from "./authorization.js";
export {
  WechatIlinkAdapter,
  type WechatCredential,
  type WechatIlinkAdapterOptions,
} from "./client.js";
export { materializeWechatInboundMedia } from "./media.js";
export { normalizeWechatMessage, WechatCompatibilityError } from "./normalize.js";
export type { GetUpdatesResponse, MessageItem, WechatMessage } from "./protocol.js";
