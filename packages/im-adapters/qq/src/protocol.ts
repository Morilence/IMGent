export interface QqGatewayPayload {
  id?: string;
  op: number;
  d?: unknown;
  s?: number;
  t?: string;
}

export interface QqAttachment {
  url?: string;
  filename?: string;
  content_type?: string;
  size?: number;
  height?: number;
  width?: number;
}

export interface QqMessageEvent {
  id?: string;
  msg_id?: string;
  msg_seq?: number;
  content?: string;
  timestamp?: string;
  group_openid?: string;
  user_openid?: string;
  author?: {
    id?: string;
    user_openid?: string;
    member_openid?: string;
    username?: string;
    nickname?: string;
    role?: string;
  };
  member?: {
    member_openid?: string;
    role?: string;
    nick?: string;
  };
  mentions?: Array<{
    id?: string;
    user_openid?: string;
    member_openid?: string;
    username?: string;
  }>;
  message_reference?: {
    message_id?: string;
  };
  attachments?: QqAttachment[];
}

export interface QqReadyEvent {
  session_id?: string;
  user?: { id?: string };
}

export const QqOpcode = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

export const GROUP_AND_C2C_INTENT = 1 << 25;
