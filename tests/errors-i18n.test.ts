import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ERROR_DEFINITIONS,
  IMGentError,
  errorDiagnostic,
  normalizeError,
  redactSensitive,
  serializeError,
  type ErrorDescriptor,
} from "@imgent/contracts";
import { z } from "zod";
import { cliErrorEnvelope, cliExitCode } from "../src/cli/presentation.js";
import {
  normalizeLocale,
  renderError,
  resolveLocale,
  validateMessageCatalogs,
} from "../src/i18n/index.js";

test("error registry, normalization and serialization keep a stable safe contract", () => {
  const codes = Object.keys(ERROR_DEFINITIONS);
  assert.equal(new Set(codes).size, codes.length);

  const known = new IMGentError("ADAPTER_RATE_LIMITED", {
    retryAfterMs: 12_345,
    incidentId: "err_known",
  });
  assert.equal(normalizeError(known), known);
  assert.deepEqual(serializeError(known), known.descriptor);
  assert.equal(known.descriptor.retry.retryAfterMs, 12_345);

  const malicious = normalizeError({
    code: "CONFIG_FILE_INVALID",
    domain: "outbound",
    kind: "transient",
    messageKey: "error.attacker.message",
    messageParams: { path: "/srv/private", token: "token=super-secret-value" },
    retry: { strategy: "backoff", replay: "unsafe" },
  } as unknown as ErrorDescriptor).descriptor;
  assert.equal(malicious.domain, "config");
  assert.equal(malicious.kind, "validation");
  assert.equal(malicious.messageKey, ERROR_DEFINITIONS.CONFIG_FILE_INVALID.messageKey);
  assert.equal(malicious.retry.strategy, "after_user_action");
  assert.equal(malicious.messageParams, undefined);

  const raw = "vendor response token=super-secret-value at /srv/private/state.sqlite";
  const unknown = normalizeError(new Error(raw));
  assert.equal(unknown.code, "INTERNAL_UNEXPECTED_ERROR");
  assert.ok(unknown.descriptor.incidentId?.startsWith("err_"));
  assert.doesNotMatch(
    JSON.stringify(unknown.descriptor),
    /super-secret|state\.sqlite|vendor response/,
  );
  assert.doesNotMatch(JSON.stringify(errorDiagnostic(unknown)), /super-secret|state\.sqlite/);
});

test("Node, Zod and HTTP-like failures map to stable error codes", () => {
  const timeout = Object.assign(new Error("socket timeout"), { code: "ETIMEDOUT" });
  assert.equal(normalizeError(timeout).code, "ADAPTER_REQUEST_TIMEOUT");
  assert.equal(
    normalizeError(z.object({ value: z.string() }).safeParse({ value: 1 }).error).code,
    "CONFIG_FILE_INVALID",
  );
  assert.equal(normalizeError({ status: 401 }).code, "ADAPTER_AUTH_REQUIRED");
  assert.equal(normalizeError({ status: 429 }).code, "ADAPTER_RATE_LIMITED");
  assert.equal(normalizeError({ status: 503 }).code, "ADAPTER_SERVICE_UNAVAILABLE");
  assert.equal(normalizeError({ status: 422 }).code, "ADAPTER_REQUEST_REJECTED");
});

test("error diagnostics redact secrets, paths, SQL, prompts and vendor payloads", () => {
  const redacted = redactSensitive({
    token: "secret-token",
    path: "/srv/imgent/state.sqlite",
    sql: "SELECT * FROM principals",
    prompt: "private message body",
    vendorResponse: { errmsg: "raw platform response" },
    safe: { code: "ADAPTER_AUTH_REQUIRED", attempt: 2 },
  });
  const serialized = JSON.stringify(redacted);
  assert.doesNotMatch(
    serialized,
    /secret-token|state\.sqlite|SELECT \*|private message body|raw platform response/,
  );
  assert.match(serialized, /ADAPTER_AUTH_REQUIRED/);
});

test("bilingual ICU catalogs are complete and locale negotiation is deterministic", () => {
  assert.deepEqual(validateMessageCatalogs(), []);
  assert.equal(normalizeLocale("en_US.UTF-8"), "en-US");
  assert.equal(normalizeLocale("fr-FR, en-US;q=0.9, zh-CN;q=0.8"), "en-US");
  assert.equal(normalizeLocale("en-US;q=0.5, zh-CN;q=0.9"), "zh-CN");
  assert.equal(resolveLocale(["fr-FR", undefined], "zh-CN"), "zh-CN");

  const descriptor = new IMGentError("AGENT_AUTH_REQUIRED", {
    incidentId: "err_language",
  }).descriptor;
  const zh = renderError(descriptor, "zh-CN");
  const en = renderError(descriptor, "en-US");
  assert.match(zh.message, /尚未登录/);
  assert.match(en.message, /not signed in/i);
  assert.equal(en.incidentId, "err_language");
});

test("CLI envelopes are localized, diagnostic-free and use fixed exit classes", () => {
  const config = new IMGentError("CONFIG_FILE_INVALID", {
    diagnostic: { path: "/private/config.json" },
  });
  const envelope = cliErrorEnvelope(config.descriptor, "en-US");
  assert.deepEqual(Object.keys(envelope), ["ok", "locale", "error"]);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "CONFIG_FILE_INVALID");
  assert.doesNotMatch(JSON.stringify(envelope), /private|diagnostic|config\.json/);
  assert.equal(cliExitCode(config.descriptor), 2);
  assert.equal(cliExitCode(new IMGentError("AGENT_AUTH_REQUIRED").descriptor), 3);
  assert.equal(cliExitCode(new IMGentError("ADAPTER_SERVICE_UNAVAILABLE").descriptor), 4);
  assert.equal(cliExitCode(new IMGentError("INTERNAL_UNEXPECTED_ERROR").descriptor), 1);
});
