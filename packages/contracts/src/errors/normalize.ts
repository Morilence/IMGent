import { ERROR_DEFINITIONS, type ErrorCode } from "./definitions.js";
import { IMGentError, type IMGentErrorOptions } from "./imgent-error.js";
import { redactSensitive } from "./redaction.js";
import type { ErrorDescriptor } from "./descriptor.js";

export function isErrorDescriptor(value: unknown): value is ErrorDescriptor {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ErrorDescriptor>;
  return (
    typeof candidate.code === "string" &&
    candidate.code in ERROR_DEFINITIONS &&
    typeof candidate.messageKey === "string" &&
    Boolean(candidate.retry)
  );
}

export function normalizeError(
  error: unknown,
  fallbackCode: ErrorCode = "INTERNAL_UNEXPECTED_ERROR",
  options: Omit<IMGentErrorOptions, "cause"> = {},
): IMGentError {
  if (error instanceof IMGentError) return error;
  if (isErrorDescriptor(error)) {
    return new IMGentError(error.code, {
      ...(error.retry.retryAfterMs === undefined ? {} : { retryAfterMs: error.retry.retryAfterMs }),
      ...(error.incidentId ? { incidentId: error.incidentId } : {}),
      ...(options.diagnostic ? { diagnostic: options.diagnostic } : {}),
      cause: error,
    });
  }
  const nodeCode =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  const errorName =
    error && typeof error === "object" && "name" in error
      ? String((error as { name?: unknown }).name ?? "")
      : "";
  if (
    errorName === "ZodError" ||
    (error && typeof error === "object" && "issues" in error && Array.isArray(error.issues))
  ) {
    return new IMGentError("CONFIG_FILE_INVALID", {
      ...options,
      cause: error,
      diagnostic: { ...options.diagnostic, causeName: errorName || "ValidationError" },
    });
  }
  const httpStatus =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status?: unknown }).status)
      : undefined;
  if (httpStatus === 401) {
    return new IMGentError("ADAPTER_AUTH_REQUIRED", { ...options, cause: error });
  }
  if (httpStatus === 403) {
    return new IMGentError("ADAPTER_PERMISSION_DENIED", { ...options, cause: error });
  }
  if (httpStatus === 429) {
    return new IMGentError("ADAPTER_RATE_LIMITED", { ...options, cause: error });
  }
  if (httpStatus !== undefined && httpStatus >= 500) {
    return new IMGentError("ADAPTER_SERVICE_UNAVAILABLE", { ...options, cause: error });
  }
  if (httpStatus !== undefined && httpStatus >= 400) {
    return new IMGentError("ADAPTER_REQUEST_REJECTED", { ...options, cause: error });
  }
  if (nodeCode === "ETIMEDOUT" || nodeCode === "UND_ERR_CONNECT_TIMEOUT") {
    return new IMGentError("ADAPTER_REQUEST_TIMEOUT", {
      ...options,
      cause: error,
      diagnostic: {
        ...options.diagnostic,
        nodeCode,
        cause: error instanceof Error ? error.message : String(error),
      },
    });
  }
  if (["ECONNRESET", "ECONNREFUSED", "ENETUNREACH", "EPIPE"].includes(nodeCode)) {
    return new IMGentError("ADAPTER_CONNECTION_FAILED", {
      ...options,
      cause: error,
      diagnostic: {
        ...options.diagnostic,
        nodeCode,
        cause: error instanceof Error ? error.message : String(error),
      },
    });
  }
  return new IMGentError(fallbackCode, {
    ...options,
    cause: error,
    diagnostic: {
      ...options.diagnostic,
      causeName: error instanceof Error ? error.name : typeof error,
      cause: error instanceof Error ? error.message : String(error),
    },
  });
}

export function serializeError(error: unknown, fallbackCode?: ErrorCode): ErrorDescriptor {
  return normalizeError(error, fallbackCode).descriptor;
}

export function errorDiagnostic(error: unknown): Record<string, unknown> {
  const normalized = normalizeError(error);
  return redactSensitive({
    ...normalized.descriptor,
    ...(normalized.diagnostic ? { diagnostic: normalized.diagnostic } : {}),
    cause:
      normalized.cause instanceof Error
        ? { name: normalized.cause.name, message: normalized.cause.message }
        : normalized.cause,
  }) as Record<string, unknown>;
}
