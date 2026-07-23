const SENSITIVE_KEYS =
  /token|secret|password|authorization|replyContext|context_token|memoryValue|messageBody/i;
const SENSITIVE_TEXT =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~+/=-]{8,}|(?:api[_-]?key|token|password|passwd|secret)\s*[:=]\s*\S+/gi;

function redactText(value: string): string {
  return value.replaceAll(SENSITIVE_TEXT, "[redacted]");
}

function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactText(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redact(entry, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SENSITIVE_KEYS.test(key) ? "[redacted]" : redact(entry, seen),
    ]),
  );
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export class Logger {
  constructor(private readonly component: string) {}

  log(level: LogLevel, eventType: string, details: Record<string, unknown> = {}): void {
    const line = {
      timestamp: new Date().toISOString(),
      level,
      component: this.component,
      eventType,
      ...(redact(details) as Record<string, unknown>),
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
}

export function redactForLog(value: unknown): unknown {
  return redact(value);
}
