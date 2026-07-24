import { randomUUID } from "node:crypto";
import { ERROR_DEFINITIONS, type ErrorCode } from "./definitions.js";
import { safeErrorParams } from "./redaction.js";
import type { ErrorDescriptor } from "./descriptor.js";
import type { ErrorDefinition, ErrorMessageParam } from "./types.js";

export interface IMGentErrorOptions {
  messageParams?: Record<string, ErrorMessageParam>;
  actionParams?: Record<string, ErrorMessageParam>;
  retryAfterMs?: number;
  incidentId?: string;
  cause?: unknown;
  diagnostic?: Record<string, unknown>;
}

export class IMGentError extends Error {
  readonly descriptor: ErrorDescriptor;
  readonly diagnostic: Record<string, unknown> | undefined;

  constructor(
    readonly code: ErrorCode,
    options: IMGentErrorOptions = {},
  ) {
    super(code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "IMGentError";
    const definition: ErrorDefinition = ERROR_DEFINITIONS[code];
    const messageParams = safeErrorParams(options.messageParams, definition.messageParamKeys);
    const actionParams = safeErrorParams(options.actionParams, definition.actionParamKeys);
    this.descriptor = {
      code,
      domain: definition.domain,
      kind: definition.kind,
      messageKey: definition.messageKey,
      ...(messageParams ? { messageParams } : {}),
      ...(definition.actionKey ? { actionKey: definition.actionKey } : {}),
      ...(actionParams ? { actionParams } : {}),
      retry: {
        strategy: definition.retry.strategy,
        replay: definition.retry.replay,
        ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
      },
      incidentId: options.incidentId ?? `err_${randomUUID()}`,
    };
    this.diagnostic = options.diagnostic;
  }
}
