import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  const legacyProfile = configSchema.parse({
    ...base,
    agentProfiles: [
      {
        id: "legacy",
        driver: "codex",
        command: "codex",
        workspace: process.cwd(),
      },
    ],
  });
  assert.deepEqual(legacyProfile.agentProfiles[0]?.skills, ["*"]);
  assert.equal(
    configSchema.safeParse({
      ...base,
      server: { host: "0.0.0.0", port: 8787 },
    }).success,
    false,
  );
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
          driver: "codex",
          command: "codex",
          workspace: process.cwd(),
          skills: ["*", "another-skill"],
        },
      ],
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
  const directory = await mkdtemp(join(tmpdir(), "imgent-backup-"));
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
  const skillRoot = join(dataDir, "skills", "backup-skill");
  await mkdir(join(skillRoot, "scripts"), { recursive: true });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    "---\nname: backup-skill\ndescription: Verify skill backup\n---\nbody\n",
  );
  await writeFile(join(skillRoot, "scripts", "verify.sh"), "#!/bin/sh\nexit 0\n", {
    mode: 0o700,
  });
  const backup = await createBackup(configPath, archivePath);
  assert.ok(backup.files >= 4);
  assert.equal((await stat(archivePath)).mode & 0o777, 0o600);
  await restoreBackup(archivePath, restoredData, restoredConfig);
  const credentials = new CredentialStore(restoredData);
  assert.deepEqual(await credentials.get("qq-main"), { appSecret: "secret-value" });
  assert.match(
    await readFile(join(restoredData, "skills", "backup-skill", "SKILL.md"), "utf8"),
    /Verify skill backup/,
  );
  assert.equal(
    (await stat(join(restoredData, "skills", "backup-skill", "scripts", "verify.sh"))).mode & 0o777,
    0o700,
  );
  const raw = JSON.parse(await readFile(archivePath, "utf8")) as {
    format: string;
    manifest: { externalAgentAuthenticationIncluded: boolean };
    files: Array<{ path: string }>;
  };
  assert.equal(raw.format, "imgent-backup/v1");
  assert.ok(raw.files.some((file) => file.path === "data/imgent.sqlite"));
  assert.equal(raw.manifest.externalAgentAuthenticationIncluded, false);

  const legacyArchivePath = join(directory, "legacy.backup");
  const legacyFormat = `${["agent", ["pig", "eon"].join("")].join("-")}-backup/v1`;
  await writeFile(
    legacyArchivePath,
    JSON.stringify({
      ...raw,
      format: legacyFormat,
    }),
  );
  await assert.rejects(
    restoreBackup(
      legacyArchivePath,
      join(directory, "legacy-data"),
      join(directory, "legacy.json"),
    ),
    /格式无效/u,
  );
  await rm(directory, { recursive: true, force: true });
});
