import { createHash } from "node:crypto";
import type { IMGentConfig } from "@imgent/contracts";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !/(secret|token|credential)$/iu.test(key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

export function configHash(config: IMGentConfig): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(config)))
    .digest("hex");
}
