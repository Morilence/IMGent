import { randomUUID } from "node:crypto";
import { ERROR_DEFINITIONS, type ErrorCode } from "./definitions.js";
import type { ErrorDescriptor } from "./descriptor.js";
import type { ErrorDefinition } from "./types.js";

export interface IMGentErrorOptions {
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
    this.descriptor = {
      code,
      domain: definition.domain,
      kind: definition.kind,
      messageKey: definition.messageKey,
      ...(definition.actionKey ? { actionKey: definition.actionKey } : {}),
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
