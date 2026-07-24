import { errorDiagnostic, normalizeError, redactSensitive } from "@imgent/contracts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export class Logger {
  constructor(private readonly component: string) {}

  log(level: LogLevel, eventType: string, details: Record<string, unknown> = {}): void {
    const line = {
      timestamp: new Date().toISOString(),
      level,
      component: this.component,
      eventType,
      ...(redactSensitive(details) as Record<string, unknown>),
    };
    const output = JSON.stringify(line);
    if (level === "error") process.stderr.write(`${output}\n`);
    else process.stdout.write(`${output}\n`);
  }

  debug(event: string, details?: Record<string, unknown>): void {
    this.log("debug", event, details);
  }
  info(event: string, details?: Record<string, unknown>): void {
    this.log("info", event, details);
  }
  warn(event: string, details?: Record<string, unknown>): void {
    this.log("warn", event, details);
  }
  error(event: string, details?: Record<string, unknown>): void {
    this.log("error", event, details);
  }

  errorFrom(event: string, error: unknown, details: Record<string, unknown> = {}): void {
    const normalized = normalizeError(error);
    this.log("error", event, {
      ...details,
      errorCode: normalized.code,
      errorDomain: normalized.descriptor.domain,
      retryStrategy: normalized.descriptor.retry.strategy,
      replaySafety: normalized.descriptor.retry.replay,
      incidentId: normalized.descriptor.incidentId,
      error: errorDiagnostic(normalized),
    });
  }
}

export function redactForLog(value: unknown): unknown {
  return redactSensitive(value);
}
