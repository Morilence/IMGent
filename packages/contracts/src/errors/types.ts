export type ErrorDomain =
  | "config"
  | "storage"
  | "adapter"
  | "driver"
  | "task"
  | "outbound"
  | "approval"
  | "identity"
  | "memory"
  | "runtime"
  | "internal";

export type ErrorKind =
  | "validation"
  | "authentication"
  | "authorization"
  | "not_found"
  | "conflict"
  | "compatibility"
  | "rate_limit"
  | "timeout"
  | "transient"
  | "cancelled"
  | "internal";

export type RetryStrategy = "none" | "backoff" | "after_user_action";
export type ReplaySafety = "safe" | "unsafe" | "unknown";
export type ErrorMessageKey = `error.${string}.${"message" | "action"}`;

export interface ErrorRetryPolicy {
  strategy: RetryStrategy;
  replay: ReplaySafety;
  retryAfterMs?: number;
}

export interface ErrorDefinition {
  domain: ErrorDomain;
  kind: ErrorKind;
  messageKey: ErrorMessageKey;
  actionKey?: ErrorMessageKey;
  retry: {
    strategy: RetryStrategy;
    replay: ReplaySafety;
  };
}
