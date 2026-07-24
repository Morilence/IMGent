import type { ErrorCode } from "./definitions.js";
import type {
  ErrorDomain,
  ErrorKind,
  ErrorMessageKey,
  ErrorMessageParam,
  ErrorRetryPolicy,
} from "./types.js";

export interface ErrorDescriptor {
  code: ErrorCode;
  domain: ErrorDomain;
  kind: ErrorKind;
  messageKey: ErrorMessageKey;
  messageParams?: Record<string, ErrorMessageParam>;
  actionKey?: ErrorMessageKey;
  actionParams?: Record<string, ErrorMessageParam>;
  retry: ErrorRetryPolicy;
  incidentId?: string;
}
