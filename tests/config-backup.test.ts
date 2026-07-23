import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBackup, restoreBackup } from "../src/backup/service.js";
import { openAdminContext } from "../src/cli/context.js";
import { defaultConfig } from "../src/config/index.js";
import { configSchema } from "../src/config/schema.js";
import { writeConfig } from "../src/config/write.js";
import { CredentialStore } from "../src/security/credential-store.js";

test("configuration is strict and only exposes implemented adapters and drivers", () => {
  const base = defaultConfig(process.cwd());
  assert.equal(
    configSchema.safeParse({
      ...base,
      unknown: true,
    }).success,
    false,
  );
  assert.equal(
    configSchema.safeParse({
      ...base,
      agentProfiles: [
        {
          id: "main",
          driver: "other",
          command: "other",
          workspace: process.cwd(),
        },
      ],
    }).success,
    false,
  );
  assert.equal(
    configSchema.safeParse({
      ...base,
      bots: [
        {
          id: "telegram",
          adapter: "telegram",
          credentialRef: "telegram",
        },
      ],
    }).success,
    false,
  );
});

test("backup and restore verify checksums and preserve encrypted local credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-pigeon-backup-"));
  const workspace = join(directory, "workspace");
  const configPath = join(directory, "config.json");
  const dataDir = join(directory, "data");
  const archivePath = join(directory, "state.backup");
  const restoredData = join(directory, "restored-data");
  const restoredConfig = join(directory, "restored.json");
  await (await import("node:fs/promises")).mkdir(workspace);
  await writeConfig(configPath, {
    ...defaultConfig(workspace),
    dataDir,
  });
  const context = await openAdminContext(configPath);
  await context.credentials.set("qq-main", { appSecret: "secret-value" });
  context.store.close();
  const backup = await createBackup(configPath, archivePath);
  assert.ok(backup.files >= 4);
  assert.equal((await stat(archivePath)).mode & 0o777, 0o600);
  await restoreBackup(archivePath, restoredData, restoredConfig);
  const credentials = new CredentialStore(restoredData);
  assert.deepEqual(await credentials.get("qq-main"), { appSecret: "secret-value" });
  const raw = JSON.parse(await readFile(archivePath, "utf8")) as {
    manifest: { externalAgentAuthenticationIncluded: boolean };
  };
  assert.equal(raw.manifest.externalAgentAuthenticationIncluded, false);
  await rm(directory, { recursive: true, force: true });
});
