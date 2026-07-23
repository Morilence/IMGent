export const MessageType = {
  USER: 1,
  BOT: 2,
} as const;

export const MessageItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

export interface CdnMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}

export interface MessageItem {
  type?: number;
  msg_id?: string;
  text_item?: { text?: string };
  image_item?: {
    media?: CdnMedia;
    thumb_media?: CdnMedia;
    aeskey?: string;
    url?: string;
    mid_size?: number;
  };
  voice_item?: {
    media?: CdnMedia;
    encode_type?: number;
    playtime?: number;
    text?: string;
  };
  file_item?: {
    media?: CdnMedia;
    file_name?: string;
    md5?: string;
    len?: string;
  };
  video_item?: {
    media?: CdnMedia;
    video_size?: number;
    play_length?: number;
    video_md5?: string;
    thumb_media?: CdnMedia;
  };
  ref_msg?: {
    message_item?: MessageItem;
    title?: string;
  };
}

export interface WechatMessage {
  seq?: number | string;
  message_id?: number | string;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number | string;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  run_id?: string;
}

export interface GetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WechatMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface QrCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

export type QrStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "scaned_but_redirect"
  | "need_verifycode"
  | "verify_code_blocked"
  | "binded_redirect";

export interface QrStatusResponse {
  status: QrStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
  redirect_host?: string;
}
