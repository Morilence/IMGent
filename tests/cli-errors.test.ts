import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig } from "../src/config/index.js";
import { writeConfig } from "../src/config/write.js";

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runCli(
  wrapper: string,
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapper, executable, ...args], {
      env: { ...process.env, NODE_NO_WARNINGS: "1", ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("CLI emits localized stable JSON errors and fixed exit codes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "imgent-cli-errors-"));
  try {
    const executable = join(process.cwd(), "dist", "src", "cli", "main.js");
    const wrapper = join(directory, "node24-cli-wrapper.mjs");
    await writeFile(
      wrapper,
      [
        "const cli = process.argv[2];",
        "process.argv.splice(1, 2, cli);",
        'Object.defineProperty(process.versions, "node", { value: "24.18.0" });',
        "await import(cli);",
        "",
      ].join("\n"),
    );

    const invalidLocale = await runCli(wrapper, executable, [
      "--json",
      "--locale",
      "fr-FR",
      "unknown",
    ]);
    assert.equal(invalidLocale.code, 2);
    const invalidEnvelope = JSON.parse(invalidLocale.stdout) as {
      ok: boolean;
      locale: string;
      error: { code: string; message: string; diagnostic?: unknown };
    };
    assert.equal(invalidEnvelope.ok, false);
    assert.equal(invalidEnvelope.locale, "zh-CN");
    assert.equal(invalidEnvelope.error.code, "LANGUAGE_UNSUPPORTED");
    assert.equal(invalidEnvelope.error.diagnostic, undefined);
    assert.equal(invalidLocale.stderr, "");

    const missingPath = join(directory, "private-config-name.json");
    const missing = await runCli(wrapper, executable, [
      "--json",
      "--locale",
      "en-US",
      "--config",
      missingPath,
      "skills",
      "list",
    ]);
    assert.equal(missing.code, 2);
    const missingEnvelope = JSON.parse(missing.stdout) as {
      ok: boolean;
      locale: string;
      error: { code: string; message: string };
    };
    assert.equal(missingEnvelope.ok, false);
    assert.equal(missingEnvelope.locale, "en-US");
    assert.equal(missingEnvelope.error.code, "CONFIG_FILE_UNREADABLE");
    assert.match(missingEnvelope.error.message, /could not be read/i);
    assert.doesNotMatch(missing.stdout, /private-config-name|diagnostic/);

    const human = await runCli(wrapper, executable, ["--config", missingPath, "skills", "list"], {
      LC_ALL: "en_US.UTF-8",
      LC_MESSAGES: "",
      LANG: "",
    });
    assert.equal(human.code, 2);
    assert.equal(human.stdout, "");
    assert.match(human.stderr, /could not be read/i);
    assert.doesNotMatch(human.stderr, /private-config-name/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI --json success uses locale and a stable success envelope", async () => {
  const directory = await mkdtemp(join(tmpdir(), "imgent-cli-success-"));
  try {
    const configPath = join(directory, "imgent.json");
    await writeConfig(configPath, {
      ...defaultConfig(directory),
      defaultLocale: "en-US",
      dataDir: "./state",
    });
    const executable = join(process.cwd(), "dist", "src", "cli", "main.js");
    const wrapper = join(directory, "node24-cli-wrapper.mjs");
    await writeFile(
      wrapper,
      [
        "const cli = process.argv[2];",
        "process.argv.splice(1, 2, cli);",
        'Object.defineProperty(process.versions, "node", { value: "24.18.0" });',
        "await import(cli);",
        "",
      ].join("\n"),
    );
    const result = await runCli(wrapper, executable, [
      "--json",
      "--config",
      configPath,
      "skills",
      "list",
    ]);
    assert.equal(result.code, 0);
    const envelope = JSON.parse(result.stdout) as {
      ok: boolean;
      locale: string;
      result: { mode: string; skills: unknown[] };
    };
    assert.equal(envelope.ok, true);
    assert.equal(envelope.locale, "en-US");
    assert.equal(envelope.result.mode, "offline");
    assert.ok(Array.isArray(envelope.result.skills));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
