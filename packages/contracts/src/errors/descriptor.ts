import type { ErrorCode } from "./definitions.js";
import type { ErrorDomain, ErrorKind, ErrorMessageKey, ErrorRetryPolicy } from "./types.js";

export interface ErrorDescriptor {
  code: ErrorCode;
  domain: ErrorDomain;
  kind: ErrorKind;
  messageKey: ErrorMessageKey;
  actionKey?: ErrorMessageKey;
  retry: ErrorRetryPolicy;
  incidentId?: string;
}
