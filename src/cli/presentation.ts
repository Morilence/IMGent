import { renderError } from "../i18n/index.js";
import type { ErrorDescriptor, ErrorKind, SupportedLocale } from "@imgent/contracts";

export type CliExitCode = 1 | 2 | 3 | 4;

export interface CliErrorEnvelope {
  ok: false;
  locale: SupportedLocale;
  error: ReturnType<typeof renderError>;
}

export interface CliSuccessEnvelope {
  ok: true;
  locale: SupportedLocale;
  result: unknown;
}

const INPUT_KINDS = new Set<ErrorKind>(["validation", "not_found", "conflict", "cancelled"]);

export function cliExitCode(descriptor: ErrorDescriptor): CliExitCode {
  if (descriptor.domain === "config" || INPUT_KINDS.has(descriptor.kind)) {
    return 2;
  }
  if (
    descriptor.kind === "authentication" ||
    descriptor.kind === "authorization" ||
    descriptor.kind === "compatibility" ||
    descriptor.retry.strategy === "after_user_action"
  ) {
    return 3;
  }
  if (
    descriptor.kind === "rate_limit" ||
    descriptor.kind === "timeout" ||
    descriptor.kind === "transient" ||
    descriptor.retry.strategy === "backoff"
  ) {
    return 4;
  }
  return 1;
}

export function cliErrorEnvelope(
  descriptor: ErrorDescriptor,
  locale: SupportedLocale,
): CliErrorEnvelope {
  return {
    ok: false,
    locale,
    error: renderError(descriptor, locale),
  };
}

export function cliSuccessEnvelope(result: unknown, locale: SupportedLocale): CliSuccessEnvelope {
  return { ok: true, locale, result };
}
