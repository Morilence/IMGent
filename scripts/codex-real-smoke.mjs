import process from "node:process";
import { CodexDriver } from "@imgent/driver-codex";

const command = process.env.IMGENT_CODEX_COMMAND ?? "codex";
const workspace = process.env.IMGENT_CODEX_WORKSPACE ?? process.cwd();
const profile = {
  id: "codex-real-smoke",
  driver: "codex",
  command,
  workspace,
  permissions: { maxMode: "deny" },
  memory: { enabled: false },
};
const driver = new CodexDriver();
try {
  const readiness = await driver.checkReady(profile);
  if (!readiness.ready) {
    throw new Error(`Codex readiness failed: ${readiness.details.join("; ")}`);
  }
  let final = "";
  let completed = false;
  for await (const event of driver.runTurn({
    turnId: `smoke-${Date.now()}`,
    conversationKey: "codex-real-smoke",
    profile,
    prompt: "Reply with exactly CODEX_SMOKE_OK. Do not use any tools.",
    parts: [
      {
        type: "text",
        text: "Reply with exactly CODEX_SMOKE_OK. Do not use any tools.",
      },
    ],
    memoryContext: [],
    signal: AbortSignal.timeout(120_000),
  })) {
    if (event.type === "output-final") final = event.text;
    if (event.type === "completed") completed = event.result === "success";
    if (event.type === "error") {
      throw new Error(`${event.code}: ${event.message}`);
    }
  }
  if (!completed || final.trim() !== "CODEX_SMOKE_OK") {
    throw new Error(
      `unexpected Codex result: completed=${completed} final=${JSON.stringify(final)}`,
    );
  }
  process.stdout.write(
    JSON.stringify(
      {
        result: "ok",
        command,
        workspace,
        version: readiness.version,
        final,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await driver.close();
}
