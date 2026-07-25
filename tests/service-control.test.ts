import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ControlClient } from "../src/cli/control-client.js";
import { loadConfig, defaultConfig } from "../src/config/index.js";
import { writeConfig } from "../src/config/write.js";
import {
  CONTROL_APP_VERSION,
  CONTROL_PROTOCOL_VERSION,
  type ControlMeta,
} from "../src/control/protocol.js";
import { IdentityService } from "../src/identity/service.js";
import { CredentialStore } from "../src/security/credential-store.js";
import { resolveInstanceEndpoint } from "../src/service/instance.js";
import { IMGentService } from "../src/service/lifecycle.js";
import { OfflineLease } from "../src/service/offline-lease.js";
import { IMGentStore } from "../src/storage/store.js";
import { directMessage } from "./helpers.js";

async function availablePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function openTestStore(configPath: string): Promise<IMGentStore> {
  const config = await loadConfig(configPath);
  const credentials = new CredentialStore(config.dataDir);
  return IMGentStore.open(join(config.dataDir, "imgent.sqlite"), await credentials.secretBox());
}

test("control metadata version matches the package manifest", async () => {
  const manifest = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
    version: string;
  };
  assert.equal(CONTROL_APP_VERSION, manifest.version);
});

test("control client rejects incompatible, mismatched, and unreachable endpoints without fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "imgent-handshake-"));
  const configPath = join(directory, "imgent.json");
  try {
    await writeConfig(configPath, {
      ...defaultConfig(directory),
      dataDir: "./state",
      server: { host: "127.0.0.1", port: await availablePort() },
    });
    const config = await loadConfig(configPath);
    const endpoint = await resolveInstanceEndpoint(config.dataDir, { createDataDir: true });
    await withFakeControl(endpoint.endpoint, { protocolVersion: 1 }, async () => {
      await assert.rejects(
        ControlClient.discover(config),
        hasCode("RUNTIME_CONTROL_PROTOCOL_UNSUPPORTED"),
      );
    });
    await withFakeControl(
      endpoint.endpoint,
      {
        protocolVersion: 99,
        appVersion: "99.0.0",
        instanceId: "other",
        instanceKey: endpoint.instanceKey,
        state: "ready",
        startedAt: new Date().toISOString(),
        configHash: "other",
      },
      async () => {
        await assert.rejects(
          ControlClient.discover(config),
          hasCode("RUNTIME_CONTROL_PROTOCOL_UNSUPPORTED"),
        );
      },
    );
    await withFakeControl(
      endpoint.endpoint,
      {
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        appVersion: "0.1.0",
        instanceId: "other",
        instanceKey: "wrong-instance-key",
        state: "ready",
        startedAt: new Date().toISOString(),
        configHash: "other",
      },
      async () => {
        await assert.rejects(ControlClient.discover(config), hasCode("RUNTIME_INSTANCE_MISMATCH"));
      },
    );

    const unreachable = createNetServer((socket) => socket.destroy());
    await listenAt(unreachable, endpoint.endpoint);
    try {
      await assert.rejects(ControlClient.discover(config), hasCode("RUNTIME_CONTROL_UNREACHABLE"));
    } finally {
      await closeServer(unreachable);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("control plane owns one dataDir instance and reports configuration drift", async () => {
  const directory = await mkdtemp(join(tmpdir(), "imgent-control-"));
  const configPath = join(directory, "imgent.json");
  let service: IMGentService | undefined;
  try {
    await writeConfig(configPath, {
      ...defaultConfig(directory),
      dataDir: "./state",
      server: { host: "127.0.0.1", port: await availablePort() },
    });
    service = await IMGentService.start(configPath);
    const config = await loadConfig(configPath);
    const discovery = await ControlClient.discover(config);
    assert.equal(discovery.state, "running");
    if (discovery.state !== "running") return;
    assert.equal(discovery.meta.state, "degraded");
    assert.equal(discovery.configDrift, false);
    const status = await discovery.client.get<{
      service: { instanceId: string; state: string };
      readiness: { ready: boolean };
    }>("/v3/status");
    assert.equal(status.service.instanceId, discovery.meta.instanceId);
    assert.equal(status.service.state, "degraded");
    assert.equal(status.readiness.ready, false);

    const endpoint = await resolveInstanceEndpoint(config.dataDir);
    const metadata = JSON.parse(await readFile(endpoint.metadataPath, "utf8")) as {
      instanceId: string;
      instanceKey: string;
      state: string;
    };
    assert.equal(metadata.instanceId, discovery.meta.instanceId);
    assert.equal(metadata.instanceKey, endpoint.instanceKey);
    assert.equal(metadata.state, "degraded");
    assert.equal((await stat(endpoint.metadataPath)).mode & 0o777, 0o600);
    if (process.platform !== "win32") {
      assert.equal((await stat(endpoint.endpoint)).mode & 0o777, 0o600);
    }

    await assert.rejects(IMGentService.start(configPath), (error: unknown) =>
      Boolean(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "RUNTIME_INSTANCE_CONFLICT",
      ),
    );
    assert.equal(
      (JSON.parse(await readFile(endpoint.metadataPath, "utf8")) as { instanceId: string })
        .instanceId,
      discovery.meta.instanceId,
    );

    await writeConfig(configPath, {
      ...defaultConfig(directory),
      defaultLocale: "en-US",
      dataDir: "./state",
      server: config.server,
    });
    const drifted = await ControlClient.discover(await loadConfig(configPath));
    assert.equal(drifted.state, "running");
    if (drifted.state === "running") {
      assert.equal(drifted.configDrift, true);
      assert.equal(
        (await drifted.client.get<{ instanceId: string }>("/v3/meta")).instanceId,
        service.instanceId,
      );
    }
  } finally {
    await service?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("external adapter authentication failures degrade the service instead of aborting startup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "imgent-degraded-"));
  const configPath = join(directory, "imgent.json");
  let service: IMGentService | undefined;
  try {
    await writeConfig(configPath, {
      ...defaultConfig(directory),
      dataDir: "./state",
      server: { host: "127.0.0.1", port: await availablePort() },
      agentProfiles: [
        {
          id: "main",
          driver: "codex",
          command: "missing-codex-for-readiness-test",
          workspace: directory,
          skills: ["*"],
          permissions: { maxMode: "ask" },
          memory: { enabled: false },
        },
      ],
      bots: [
        {
          id: "qq-main",
          adapter: "qq",
          transport: "websocket",
          platformBotId: "app-id",
          credentialRef: "missing-credential",
          groupIngestionDefault: "triggered",
          enabled: true,
        },
      ],
      routes: [{ botInstanceId: "qq-main", agentProfileId: "main" }],
    });
    service = await IMGentService.start(configPath);
    assert.equal(service.state(), "degraded");
    const readiness = await service.readiness();
    assert.equal(readiness.ready, false);
    assert.equal(readiness.bots["qq-main"]?.ready, false);
    assert.equal(readiness.bots["qq-main"]?.issues[0]?.code, "ADAPTER_AUTH_REQUIRED");
  } finally {
    await service?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("local health binding failures abort startup and release the control endpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "imgent-fatal-"));
  const configPath = join(directory, "imgent.json");
  const occupied = createNetServer();
  try {
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", resolve);
    });
    const address = occupied.address();
    assert.ok(address && typeof address === "object");
    await writeConfig(configPath, {
      ...defaultConfig(directory),
      dataDir: "./state",
      server: { host: "127.0.0.1", port: address.port },
    });
    await assert.rejects(IMGentService.start(configPath));
    const discovery = await ControlClient.discover(await loadConfig(configPath));
    assert.equal(discovery.state, "stopped");
    const endpoint = await resolveInstanceEndpoint((await loadConfig(configPath)).dataDir);
    await assert.rejects(readFile(endpoint.metadataPath), { code: "ENOENT" });
  } finally {
    await closeServer(occupied);
    await rm(directory, { recursive: true, force: true });
  }
});

test("insecure data directory permissions are a fatal local storage error", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX directory mode checks are not applicable on Windows");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "imgent-data-mode-"));
  const configPath = join(directory, "imgent.json");
  const dataDir = join(directory, "state");
  try {
    await mkdir(dataDir);
    await chmod(dataDir, 0o755);
    await writeConfig(configPath, {
      ...defaultConfig(directory),
      dataDir,
      server: { host: "127.0.0.1", port: await availablePort() },
    });
    await assert.rejects(IMGentService.start(configPath), hasCode("STORAGE_UNAVAILABLE"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("offline ownership lease closes the service-start race", async () => {
  const directory = await mkdtemp(join(tmpdir(), "imgent-offline-lease-"));
  const configPath = join(directory, "imgent.json");
  let lease: OfflineLease | undefined;
  let service: IMGentService | undefined;
  try {
    await writeConfig(configPath, {
      ...defaultConfig(directory),
      dataDir: "./state",
      server: { host: "127.0.0.1", port: await availablePort() },
    });
    const config = await loadConfig(configPath);
    const endpoint = await resolveInstanceEndpoint(config.dataDir, { createDataDir: true });
    lease = await OfflineLease.acquire(endpoint);
    if (process.platform !== "win32") {
      assert.equal((await stat(endpoint.endpoint)).mode & 0o777, 0o600);
    }
    await assert.rejects(IMGentService.start(configPath), hasCode("RUNTIME_INSTANCE_CONFLICT"));
    await lease.release();
    lease = undefined;
    service = await IMGentService.start(configPath);
    assert.equal(service.state(), "degraded");
  } finally {
    await lease?.release();
    await service?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("service safely removes a stale user-owned Unix socket before binding", async (context) => {
  if (process.platform === "win32") {
    context.skip("Unix socket stale-entry behavior is not applicable on Windows");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "imgent-stale-"));
  const configPath = join(directory, "imgent.json");
  let staleOwner: ChildProcess | undefined;
  let service: IMGentService | undefined;
  try {
    await writeConfig(configPath, {
      ...defaultConfig(directory),
      dataDir: "./state",
      server: { host: "127.0.0.1", port: await availablePort() },
    });
    const config = await loadConfig(configPath);
    const endpoint = await resolveInstanceEndpoint(config.dataDir, { createDataDir: true });
    staleOwner = spawn(
      process.execPath,
      [
        "-e",
        "import('node:net').then(({createServer})=>createServer().listen(process.argv[1],()=>console.log('ready')))",
        endpoint.endpoint,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await waitForOutput(staleOwner, "ready");
    staleOwner.kill("SIGKILL");
    await waitForChildClose(staleOwner);
    staleOwner = undefined;
    assert.equal((await stat(endpoint.endpoint)).isSocket(), true);

    service = await IMGentService.start(configPath);
    assert.equal(service.state(), "degraded");
  } finally {
    if (staleOwner) {
      staleOwner.kill("SIGKILL");
      await waitForChildClose(staleOwner);
    }
    await service?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI routes online commands to the service and blocks offline mutations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "imgent-process-"));
  const configPath = join(directory, "imgent.json");
  const wrapper = join(directory, "node24-cli-wrapper.mjs");
  const executable = join(process.cwd(), "dist", "src", "cli", "main.js");
  let serviceProcess: ChildProcess | undefined;
  try {
    await writeConfig(configPath, {
      ...defaultConfig(directory),
      dataDir: "./state",
      server: { host: "127.0.0.1", port: await availablePort() },
    });
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
    const seed = await openTestStore(configPath);
    const direct = seed.ingest(
      directMessage({ messageId: "seed-direct", dedupeKey: "seed-direct" }),
      "main",
      "main:qq:qq-main:direct:user-1",
      undefined,
      false,
    );
    const group = seed.ingest(
      directMessage({
        messageId: "seed-group",
        dedupeKey: "seed-group",
        conversation: { kind: "group", platformConversationId: "group-1" },
        actor: { platformUserId: "user-1", displayName: "User", role: "admin" },
      }),
      "main",
      "main:qq:qq-main:group:group-1",
      undefined,
      false,
    );
    const pairingCode = new IdentityService(seed).createPairingCode(direct.platformIdentityId);
    seed.close();
    serviceProcess = spawn(
      process.execPath,
      [wrapper, executable, "--config", configPath, "start"],
      {
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    serviceProcess.stdout?.resume();
    serviceProcess.stderr?.resume();
    await waitFor(async () => {
      const discovery = await ControlClient.discover(await loadConfig(configPath));
      return discovery.state === "running" && discovery.meta.state === "degraded";
    });

    const statusResult = await runCli(wrapper, executable, [
      "--json",
      "--config",
      configPath,
      "status",
    ]);
    assert.equal(statusResult.code, 0);
    const statusEnvelope = JSON.parse(statusResult.stdout) as {
      ok: boolean;
      result: {
        mode: string;
        service: { state: string; instanceId: string };
        readiness: { ready: boolean };
      };
    };
    assert.equal(statusEnvelope.ok, true);
    assert.equal(statusEnvelope.result.mode, "online");
    assert.equal(statusEnvelope.result.service.state, "degraded");
    assert.equal(statusEnvelope.result.readiness.ready, false);
    const instanceId = statusEnvelope.result.service.instanceId;

    const doctor = await runCli(wrapper, executable, ["--json", "--config", configPath, "doctor"]);
    assert.equal(doctor.code, 2);
    const doctorEnvelope = JSON.parse(doctor.stdout) as {
      result: {
        mode: string;
        checks: Array<{ check: string; details?: { service?: { instanceId: string } } }>;
      };
    };
    assert.equal(doctorEnvelope.result.mode, "online");
    assert.equal(
      doctorEnvelope.result.checks.find((entry) => entry.check === "runtime")?.details?.service
        ?.instanceId,
      instanceId,
    );

    const paired = await runCli(wrapper, executable, [
      "--json",
      "--config",
      configPath,
      "pair",
      pairingCode,
    ]);
    assert.equal(paired.code, 0);
    const pairedEnvelope = JSON.parse(paired.stdout) as {
      result: { principalId: string; service: { instanceId: string } };
    };
    assert.equal(pairedEnvelope.result.principalId, direct.principalId);
    assert.equal(pairedEnvelope.result.service.instanceId, instanceId);
    const pairedAgain = await runCli(wrapper, executable, [
      "--json",
      "--config",
      configPath,
      "pair",
      pairingCode,
    ]);
    assert.equal(pairedAgain.code, 0);
    assert.equal(
      (JSON.parse(pairedAgain.stdout) as { result: { principalId: string } }).result.principalId,
      direct.principalId,
    );
    const authorized = await runCli(wrapper, executable, [
      "--json",
      "--config",
      configPath,
      "group",
      "authorize",
      group.conversationSpaceId,
      "--principal",
      direct.principalId,
    ]);
    assert.equal(authorized.code, 0);
    const authorizedEnvelope = JSON.parse(authorized.stdout) as {
      result: { result: string; service: { instanceId: string } };
    };
    assert.equal(authorizedEnvelope.result.result, "group-authorized");
    assert.equal(authorizedEnvelope.result.service.instanceId, instanceId);
    const listedGroups = await runCli(wrapper, executable, [
      "--json",
      "--config",
      configPath,
      "group",
      "list",
    ]);
    assert.equal(listedGroups.code, 0);
    const groupsEnvelope = JSON.parse(listedGroups.stdout) as {
      result: {
        service: { instanceId: string };
        groups: Array<{ conversationSpaceId: string; authorized: number }>;
      };
    };
    assert.equal(groupsEnvelope.result.service.instanceId, instanceId);
    assert.equal(
      groupsEnvelope.result.groups.find(
        (entry) => entry.conversationSpaceId === group.conversationSpaceId,
      )?.authorized,
      1,
    );

    const backupPath = join(directory, "online.backup");
    const backup = await runCli(wrapper, executable, [
      "--json",
      "--config",
      configPath,
      "backup",
      "--output",
      backupPath,
    ]);
    assert.equal(backup.code, 0);
    const backupEnvelope = JSON.parse(backup.stdout) as {
      result: { mode: string; path: string; files: number };
    };
    assert.equal(backupEnvelope.result.mode, "online");
    assert.equal(backupEnvelope.result.path, backupPath);
    assert.ok(backupEnvelope.result.files >= 3);
    assert.equal((await stat(backupPath)).mode & 0o777, 0o600);

    const blocked = await runCli(wrapper, executable, [
      "--json",
      "--config",
      configPath,
      "skills",
      "init",
      "must-not-exist",
    ]);
    assert.equal(blocked.code, 2);
    assert.equal(
      (JSON.parse(blocked.stdout) as { error: { code: string } }).error.code,
      "RUNTIME_SERVICE_MUST_STOP",
    );

    const blockedRestore = await runCli(wrapper, executable, [
      "--json",
      "--config",
      configPath,
      "restore",
      backupPath,
      "--data-dir",
      join(directory, "state"),
      "--force",
    ]);
    assert.equal(blockedRestore.code, 2);
    assert.equal(
      (JSON.parse(blockedRestore.stdout) as { error: { code: string } }).error.code,
      "RUNTIME_SERVICE_MUST_STOP",
    );

    const conflict = await runCli(wrapper, executable, ["--json", "--config", configPath, "start"]);
    assert.equal(conflict.code, 2);
    assert.equal(
      (JSON.parse(conflict.stdout) as { error: { code: string } }).error.code,
      "RUNTIME_INSTANCE_CONFLICT",
    );

    await stopChild(serviceProcess);
    serviceProcess = undefined;
    await waitFor(
      async () => (await ControlClient.discover(await loadConfig(configPath))).state === "stopped",
    );
    const offlineStatus = await runCli(wrapper, executable, [
      "--json",
      "--config",
      configPath,
      "status",
    ]);
    assert.equal(offlineStatus.code, 0);
    const offlineEnvelope = JSON.parse(offlineStatus.stdout) as {
      result: { mode: string; service: { state: string }; liveReadinessAvailable: boolean };
    };
    assert.equal(offlineEnvelope.result.mode, "offline");
    assert.equal(offlineEnvelope.result.service.state, "stopped");
    assert.equal(offlineEnvelope.result.liveReadinessAvailable, false);

    const offlineBackupPath = join(directory, "offline.backup");
    const offlineBackup = await runCli(wrapper, executable, [
      "--json",
      "--config",
      configPath,
      "backup",
      "--output",
      offlineBackupPath,
    ]);
    assert.equal(offlineBackup.code, 0);
    assert.equal(
      (JSON.parse(offlineBackup.stdout) as { result: { mode: string } }).result.mode,
      "offline",
    );
    const restoredConfig = join(directory, "restored.json");
    const restoredData = join(directory, "restored-state");
    const restored = await runCli(wrapper, executable, [
      "--json",
      "--config",
      restoredConfig,
      "restore",
      offlineBackupPath,
      "--data-dir",
      restoredData,
    ]);
    assert.equal(restored.code, 0);
    assert.equal(
      (JSON.parse(restored.stdout) as { result: { dataDir: string } }).result.dataDir,
      restoredData,
    );
    await stat(join(restoredData, "imgent.sqlite"));

    const offlinePair = await runCli(wrapper, executable, [
      "--json",
      "--config",
      configPath,
      "pair",
      "INVALID",
    ]);
    assert.equal(offlinePair.code, 2);
    assert.equal(
      (JSON.parse(offlinePair.stdout) as { error: { code: string } }).error.code,
      "RUNTIME_SERVICE_NOT_RUNNING",
    );
  } finally {
    if (serviceProcess) await stopChild(serviceProcess);
    await rm(directory, { recursive: true, force: true });
  }
});

async function runCli(
  wrapper: string,
  executable: string,
  arguments_: readonly string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapper, executable, ...arguments_], {
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
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

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("IMGent service did not stop after SIGTERM"));
    }, 5_000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForOutput(child: ChildProcess, expected: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}`)), 5_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (!chunk.includes(expected)) return;
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`Stale socket helper exited early with ${code}`));
    });
  });
}

async function waitForChildClose(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for IMGent service state");
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

async function withFakeControl(
  endpoint: string,
  meta: ControlMeta | { protocolVersion: number },
  operation: () => Promise<void>,
): Promise<void> {
  const server = createHttpServer((_request, response) => {
    const body = JSON.stringify({ ok: true, data: meta, requestId: "fake-request" });
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  });
  await listenAt(server, endpoint);
  try {
    await operation();
  } finally {
    await closeServer(server);
  }
}

async function listenAt(
  server: ReturnType<typeof createHttpServer> | ReturnType<typeof createNetServer>,
  endpoint: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(
  server: ReturnType<typeof createHttpServer> | ReturnType<typeof createNetServer>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
