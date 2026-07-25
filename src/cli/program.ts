import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, copyFile, lstat, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { authorizeWechatIlink } from "@imgent/adapter-wechat-ilink";
import { IMGentError, normalizeError } from "@imgent/contracts";
import { Command, CommanderError, Option } from "commander";
import qrcode from "qrcode-terminal";
import { restoreBackup } from "../backup/service.js";
import { defaultConfig, loadConfig } from "../config/index.js";
import { readRawConfig, updateConfig, writeConfig } from "../config/write.js";
import { normalizeLocale, renderError, renderErrorText, resolveLocale } from "../i18n/index.js";
import { renderReadiness, type ReadinessReport } from "../service/application.js";
import { resolveInstanceEndpoint } from "../service/instance.js";
import { IMGentService } from "../service/lifecycle.js";
import { OfflineAdminService } from "../service/offline-admin-service.js";
import { OfflineLease } from "../service/offline-lease.js";
import { IMGENT_VERSION } from "../version.js";
import { COMMAND_CAPABILITIES, type CommandName } from "./command-capability.js";
import { ControlClient, type ControlDiscovery } from "./control-client.js";
import { cliErrorEnvelope, cliExitCode, cliSuccessEnvelope } from "./presentation.js";
import type {
  AgentProfile,
  BotInstance,
  ErrorDescriptor,
  IMGentConfig,
  SupportedLocale,
} from "@imgent/contracts";

const program = new Command();
let activeLocale: SupportedLocale = "zh-CN";
let jsonOutput = false;
const offlineLeases = new Map<string, OfflineLease>();

program
  .name("imgent")
  .description("将 QQ 与微信 iLink 安全桥接到本地 Codex / Claude Code")
  .version(IMGENT_VERSION)
  .option("-c, --config <path>", "配置文件路径", resolve("imgent.json"))
  .option("--locale <locale>", "输出语言：zh-CN 或 en-US")
  .option("--json", "输出稳定 JSON envelope", false)
  .exitOverride()
  .showHelpAfterError(false)
  .configureOutput({
    writeErr: () => undefined,
  });

program
  .command("init")
  .description("创建最小配置和数据目录")
  .option("--workspace <path>", "允许的工作区根", process.cwd())
  .option("--data-dir <path>", "数据目录（相对配置文件）", "./data")
  .option("--force", "覆盖已有配置文件", false)
  .action(async (options: { workspace: string; dataDir: string; force: boolean }) => {
    const configPath = configPathOf();
    try {
      await stat(configPath);
      await routeCommand("init", await loadConfig(configPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const workspace = resolve(options.workspace);
    await mkdir(workspace, { recursive: true });
    const config = {
      ...defaultConfig(workspace),
      dataDir: options.dataDir,
    };
    await routeCommand("init", {
      ...config,
      dataDir: resolve(dirname(configPath), options.dataDir),
    });
    await writeConfig(configPath, config, options.force);
    await mkdir(resolve(dirname(configPath), options.dataDir), {
      recursive: true,
      mode: 0o700,
    });
    print({
      result: "initialized",
      configPath,
      workspace,
      dataDir: resolve(dirname(configPath), options.dataDir),
    });
  });

const profile = program.command("profile").description("管理 AgentProfile");
profile
  .command("add <id>")
  .description("添加 Codex 或 Claude Code profile")
  .addOption(
    new Option("--driver <driver>", "Agent 驱动")
      .choices(["codex", "claude-code"])
      .makeOptionMandatory(),
  )
  .option("--command <path>", "CLI 命令；默认与驱动同名")
  .option("--workspace <path>", "固定工作区", process.cwd())
  .addOption(
    new Option("--max-mode <mode>", "权限上限").choices(["deny", "ask", "allow"]).default("ask"),
  )
  .option("--no-memory", "禁用长期记忆")
  .action(
    async (
      id: string,
      options: {
        driver: "codex" | "claude-code";
        command?: string;
        workspace: string;
        maxMode: "deny" | "ask" | "allow";
        memory: boolean;
      },
    ) => {
      const configPath = configPathOf();
      await routeCommand("profile add", await loadConfig(configPath));
      const entry: AgentProfile = {
        id,
        driver: options.driver,
        command: options.command ?? (options.driver === "codex" ? "codex" : "claude"),
        workspace: relative(dirname(configPath), resolve(options.workspace)) || ".",
        skills: ["*"],
        permissions: { maxMode: options.maxMode },
        memory: { enabled: options.memory },
      };
      await updateConfig(configPath, (config) => {
        if (config.agentProfiles.some((value) => value.id === id)) {
          throw new IMGentError("CLI_USAGE_INVALID");
        }
        return {
          ...config,
          allowedWorkspaceRoots: Array.from(
            new Set([...(config.allowedWorkspaceRoots ?? []), entry.workspace]),
          ),
          agentProfiles: [...config.agentProfiles, entry],
        };
      });
      print({ result: "profile-added", profile: entry });
    },
  );

const skillsCommand = program.command("skills").description("管理 IMGent 托管的本地 skills");

skillsCommand
  .command("list")
  .description("列出内置 skill 与本机覆盖后的启动快照")
  .action(async () => {
    const discovery = await routeCommand("skills list");
    if (discovery.state === "running") {
      print({
        mode: "online",
        service: discovery.meta,
        configDrift: discovery.configDrift,
        skills: await discovery.client.get<unknown[]>("/v2/skills"),
      });
      return;
    }
    print({
      mode: "offline",
      skills: await withOfflineAdmin((offline) => offline.skills()),
    });
  });

skillsCommand
  .command("validate")
  .description("校验所有 skill 包和 AgentProfile 引用")
  .action(async () => {
    const discovery = await routeCommand("skills validate");
    if (discovery.state === "running") {
      print({
        mode: "online",
        service: discovery.meta,
        configDrift: discovery.configDrift,
        ...(await discovery.client.post<Record<string, unknown>>("/v2/skills/validate")),
      });
      return;
    }
    print({
      mode: "offline",
      ...(await withOfflineAdmin((offline) => offline.validateSkills())),
    });
  });

skillsCommand
  .command("init <name>")
  .description("在 dataDir/skills 下创建一个本机 skill")
  .option("--description <text>", "skill 用途描述")
  .action(async (name: string, options: { description?: string }) => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 63) {
      throw new IMGentError("CLI_USAGE_INVALID");
    }
    const configPath = configPathOf();
    await routeCommand("skills init", await loadConfig(configPath));
    const config = await readRawConfig(configPath);
    const userSkillsRoot = resolve(dirname(configPath), config.dataDir, "skills");
    const skillRoot = resolve(userSkillsRoot, name);
    const description = options.description ?? `Describe when the ${name} skill should be used.`;
    if (description.length < 1 || description.length > 1_000) {
      throw new IMGentError("CLI_USAGE_INVALID");
    }
    await mkdir(userSkillsRoot, { recursive: true, mode: 0o700 });
    await mkdir(skillRoot, { recursive: false, mode: 0o700 });
    await writeFile(
      resolve(skillRoot, "SKILL.md"),
      [
        "---",
        `name: ${name}`,
        `description: ${JSON.stringify(description)}`,
        "---",
        "",
        `# ${name}`,
        "",
        "Describe the workflow, constraints, and expected outputs for this IMGent skill.",
        "",
      ].join("\n"),
      { mode: 0o600, flag: "wx" },
    );
    print({
      result: "skill-initialized",
      name,
      path: skillRoot,
      restartRequired: true,
    });
  });

const bot = program.command("bot").description("管理 BotInstance");
bot
  .command("add <adapter> <id>")
  .description("添加 QQ 或微信 iLink BotInstance")
  .addOption(new Option("--profile <id>", "路由到 AgentProfile").makeOptionMandatory())
  .option("--app-id <id>", "QQ AppID")
  .option("--app-id-env <name>", "QQ AppID 环境变量")
  .option(
    "--app-secret-env <name>",
    "从环境变量读取 QQ AppSecret 并加密落盘",
    "IMGENT_QQ_APP_SECRET",
  )
  .action(
    async (
      adapter: string,
      id: string,
      options: {
        profile: string;
        appId?: string;
        appIdEnv?: string;
        appSecretEnv: string;
      },
    ) => {
      if (adapter !== "qq" && adapter !== "wechat-ilink") {
        throw new IMGentError("CLI_USAGE_INVALID");
      }
      const configPath = configPathOf();
      await routeCommand("bot add", await loadConfig(configPath));
      const current = await readRawConfig(configPath);
      if (!current.agentProfiles.some((entry) => entry.id === options.profile)) {
        throw new IMGentError("CONFIG_FILE_INVALID");
      }
      let entry: BotInstance;
      if (adapter === "qq") {
        if (!options.appId && !options.appIdEnv) {
          throw new IMGentError("CLI_USAGE_INVALID");
        }
        const secret = process.env[options.appSecretEnv];
        if (!secret) {
          throw new IMGentError("CONFIG_FILE_INVALID");
        }
        await withOfflineAdmin((offline) => offline.setCredential(id, { appSecret: secret }));
        entry = {
          id,
          adapter: "qq",
          transport: "websocket",
          ...(options.appId ? { platformBotId: options.appId } : {}),
          ...(options.appIdEnv ? { platformBotIdEnv: options.appIdEnv } : {}),
          credentialRef: id,
          groupIngestionDefault: "triggered",
          enabled: true,
        };
      } else {
        entry = {
          id,
          adapter: "wechat-ilink",
          credentialRef: id,
          enabled: true,
        };
      }
      await updateConfig(configPath, (config) => {
        if (config.bots.some((value) => value.id === id)) {
          throw new IMGentError("CLI_USAGE_INVALID");
        }
        return {
          ...config,
          bots: [...config.bots, entry],
          routes: [...config.routes, { botInstanceId: id, agentProfileId: options.profile }],
        };
      });
      print({ result: "bot-added", bot: entry });
    },
  );

bot
  .command("authorize <id>")
  .description("通过终端 QR 流程授权微信 iLink BotInstance")
  .option("--base-url <url>", "微信 iLink API 基础 URL")
  .action(async (id: string, options: { baseUrl?: string }) => {
    const configPath = configPathOf();
    await routeCommand("bot authorize", await loadConfig(configPath));
    const config = await readRawConfig(configPath);
    const selected = config.bots.find((entry) => entry.id === id);
    if (!selected || selected.adapter !== "wechat-ilink") {
      throw new IMGentError("CLI_USAGE_INVALID");
    }
    const terminal = createInterface({ input: stdin, output: stdout });
    try {
      const authorized = await authorizeWechatIlink({
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        onQr: (value) => {
          stdout.write("请使用微信扫描二维码：\n");
          qrcode.generate(value, { small: true }, (rendered) => {
            stdout.write(`${rendered}\n`);
          });
          stdout.write(`${value}\n`);
        },
        onStatus: (status) => {
          stdout.write(`授权状态：${status}\n`);
        },
        verifyCode: async () => terminal.question("请输入微信验证码："),
      });
      await withOfflineAdmin((offline) =>
        offline.setCredential(selected.credentialRef, {
          botToken: authorized.botToken,
        }),
      );
      await updateConfig(configPath, (value) => ({
        ...value,
        bots: value.bots.map((entry) =>
          entry.id === id
            ? {
                ...entry,
                platformBotId: authorized.platformBotId,
                authorizingPlatformUserId: authorized.authorizingPlatformUserId,
                baseUrl: authorized.baseUrl,
              }
            : entry,
        ),
      }));
      print({
        result: "wechat-authorized",
        botInstanceId: id,
        platformBotId: authorized.platformBotId,
        authorizingPlatformUserId: authorized.authorizingPlatformUserId,
      });
    } finally {
      terminal.close();
    }
  });

program
  .command("pair <code>")
  .description("确认私聊一次性配对码")
  .action(async (code: string) => {
    const discovery = await requireRunning("pair");
    print({
      mode: "online",
      service: discovery.meta,
      configDrift: discovery.configDrift,
      ...(await discovery.client.post<Record<string, unknown>>(
        `/v2/pairings/${encodeURIComponent(code)}/confirm`,
      )),
    });
  });

const identity = program.command("identity").description("查看本地身份映射");
identity
  .command("list")
  .description("列出平台身份与 Principal")
  .action(async () => {
    const discovery = await routeCommand("identity list");
    if (discovery.state === "running") {
      print({
        mode: "online",
        service: discovery.meta,
        configDrift: discovery.configDrift,
        identities: await discovery.client.get<unknown[]>("/v2/identities"),
      });
      return;
    }
    print({
      mode: "offline",
      identities: await withOfflineAdmin((offline) => offline.identities()),
    });
  });

const group = program.command("group").description("管理 QQ 群授权");
group
  .command("list")
  .description("列出已发现群空间与授权状态")
  .action(async () => {
    const discovery = await routeCommand("group list");
    if (discovery.state === "running") {
      print({
        mode: "online",
        service: discovery.meta,
        configDrift: discovery.configDrift,
        groups: await discovery.client.get<unknown[]>("/v2/groups"),
      });
      return;
    }
    print({
      mode: "offline",
      groups: await withOfflineAdmin((offline) => offline.groups()),
    });
  });

group
  .command("authorize <conversation-space-id>")
  .description("由已配对 Principal 授权一个 QQ 群")
  .requiredOption("--principal <id>", "执行授权的已配对 Principal ID")
  .action(async (conversationSpaceId: string, options: { principal: string }) => {
    const discovery = await requireRunning("group authorize");
    print({
      mode: "online",
      service: discovery.meta,
      configDrift: discovery.configDrift,
      ...(await discovery.client.post<Record<string, unknown>>(
        `/v2/groups/${encodeURIComponent(conversationSpaceId)}/authorize`,
        { principalId: options.principal },
      )),
    });
  });

program
  .command("doctor")
  .description("检查 Node、SQLite、平台和 Agent readiness")
  .action(async () => {
    const failures: ErrorDescriptor[] = [];
    let runtimeMode: "online" | "offline" = "offline";
    const checks: Array<{
      check: string;
      ok: boolean;
      details?: unknown;
    }> = [];
    checks.push({
      check: "node",
      ok: nodeSupported(),
      details: nodeSupported()
        ? process.versions.node
        : renderError(new IMGentError("RUNTIME_NODE_UNSUPPORTED").descriptor, activeLocale),
    });
    if (!nodeSupported()) {
      failures.push(new IMGentError("RUNTIME_NODE_UNSUPPORTED").descriptor);
    }
    try {
      const discovery = await routeCommand("doctor");
      if (discovery.state === "running") {
        runtimeMode = "online";
        const readiness = await discovery.client.diagnostics<ReadinessReport>();
        checks.push({
          check: "runtime",
          ok: readiness.ready,
          details: {
            mode: "online",
            service: discovery.meta,
            configDrift: discovery.configDrift,
            readiness: renderReadiness(readiness, activeLocale),
          },
        });
        if (!readiness.ready) {
          failures.push(
            ...readiness.issues,
            ...Object.values(readiness.bots).flatMap((entry) => entry.issues),
            ...Object.values(readiness.profiles).flatMap((entry) => entry.issues),
          );
        }
      } else {
        await withOfflineAdmin(async (offline) => {
          const readiness = await offline.environmentReadiness();
          checks.push({
            check: "runtime",
            ok: readiness.ready,
            details: {
              mode: "offline",
              service: { state: "stopped" },
              database: offline.persistentStatus().database,
              skills: await offline.validateSkills(),
              environmentReadiness: renderReadiness(readiness, activeLocale),
              liveReadinessAvailable: false,
            },
          });
          if (!readiness.ready) {
            failures.push(
              ...readiness.issues,
              ...Object.values(readiness.bots).flatMap((entry) => entry.issues),
              ...Object.values(readiness.profiles).flatMap((entry) => entry.issues),
            );
          }
        });
      }
    } catch (error) {
      const normalized = normalizeError(error);
      failures.push(normalized.descriptor);
      checks.push({
        check: "runtime",
        ok: false,
        details: renderError(normalized.descriptor, activeLocale),
      });
    }
    print({ mode: runtimeMode, checks });
    if (failures.length > 0) {
      process.exitCode = Math.max(...failures.map((failure) => cliExitCode(failure)));
    }
  });

program
  .command("status")
  .description("显示数据库积压、Bot 与 Agent readiness")
  .action(async () => {
    const discovery = await routeCommand("status");
    if (discovery.state === "running") {
      const status = await discovery.client.get<
        Record<string, unknown> & { readiness: ReadinessReport }
      >("/v2/status");
      print({
        ...status,
        mode: "online",
        configDrift: discovery.configDrift,
        readiness: renderReadiness(status.readiness, activeLocale),
      });
      return;
    }
    await withOfflineAdmin(async (offline) => {
      print({
        mode: "offline",
        service: { state: "stopped" },
        ...offline.persistentStatus(),
        readiness: null,
        liveReadinessAvailable: false,
      });
    });
  });

program
  .command("start")
  .description("以前台常驻服务启动 IMGent")
  .action(async () => {
    const stopSignal = Promise.race([once(process, "SIGINT"), once(process, "SIGTERM")]);
    const service = await IMGentService.start(configPathOf());
    try {
      await stopSignal;
    } finally {
      await service.stop();
    }
  });

program
  .command("backup")
  .description("创建带 manifest 和校验和的一致性备份")
  .option("--output <file>", "备份文件路径")
  .action(async (options: { output?: string }) => {
    const output =
      options.output ?? resolve(`imgent-${new Date().toISOString().replaceAll(":", "-")}.backup`);
    const discovery = await routeCommand("backup");
    if (discovery.state === "running") {
      const controlled = await discovery.client.post<{
        artifact: string;
        files: number;
        bytes: number;
      }>("/v2/backups");
      const path = await deliverControlledBackup(controlled.artifact, output);
      print({
        mode: "online",
        service: discovery.meta,
        configDrift: discovery.configDrift,
        path,
        files: controlled.files,
        bytes: controlled.bytes,
      });
      return;
    }
    print({
      mode: "offline",
      ...(await withOfflineAdmin((offline) => offline.createBackup(output))),
    });
  });

program
  .command("restore <file>")
  .description("验证并恢复备份到空数据目录")
  .requiredOption("--data-dir <path>", "目标数据目录")
  .option("--force", "明确覆盖已有目标", false)
  .action(async (file: string, options: { dataDir: string; force: boolean }) => {
    try {
      await stat(configPathOf());
      await routeCommand("restore", await loadConfig(configPathOf()));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await requireStoppedForDataDir("restore", options.dataDir);
    print(await restoreBackup(file, options.dataDir, configPathOf(), options.force));
  });

function configPathOf(): string {
  return resolve(program.opts<{ config: string }>().config);
}

async function withOfflineAdmin<T>(
  operation: (offline: OfflineAdminService) => T | Promise<T>,
): Promise<T> {
  const offline = await OfflineAdminService.open(configPathOf());
  try {
    return await operation(offline);
  } finally {
    offline.close();
  }
}

async function routeCommand(
  command: CommandName,
  config?: IMGentConfig,
): Promise<ControlDiscovery> {
  const capability = COMMAND_CAPABILITIES[command];
  const resolvedConfig = config ?? (await loadConfig(configPathOf()));
  const endpoint = await resolveInstanceEndpoint(resolvedConfig.dataDir);
  const discovery: ControlDiscovery = offlineLeases.has(endpoint.instanceKey)
    ? { state: "stopped", endpoint }
    : await ControlClient.discover(resolvedConfig);
  if (discovery.state === "running" && capability === "offline") {
    throw new IMGentError("RUNTIME_SERVICE_MUST_STOP");
  }
  if (discovery.state === "stopped" && capability === "online") {
    throw new IMGentError("RUNTIME_SERVICE_NOT_RUNNING");
  }
  if (discovery.state === "stopped" && !offlineLeases.has(discovery.endpoint.instanceKey)) {
    try {
      const lease = await OfflineLease.acquire(discovery.endpoint);
      offlineLeases.set(discovery.endpoint.instanceKey, lease);
    } catch (error) {
      if (capability === "dual") {
        const raced = await ControlClient.discover(resolvedConfig);
        if (raced.state === "running") return raced;
      }
      throw error;
    }
  }
  return discovery;
}

async function requireRunning(
  command: Extract<CommandName, "pair" | "group authorize">,
): Promise<Extract<ControlDiscovery, { state: "running" }>> {
  const discovery = await routeCommand(command);
  if (discovery.state === "stopped") throw new IMGentError("RUNTIME_SERVICE_NOT_RUNNING");
  return discovery;
}

async function requireStopped(command: Extract<CommandName, "restore">, config: IMGentConfig) {
  await routeCommand(command, config);
}

async function requireStoppedForDataDir(
  command: Extract<CommandName, "restore">,
  dataDir: string,
): Promise<void> {
  await requireStopped(command, {
    ...defaultConfig(process.cwd()),
    dataDir: resolve(dataDir),
  });
}

async function deliverControlledBackup(artifact: string, outputPath: string): Promise<string> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.backup$/u.test(
      artifact,
    )
  ) {
    throw new IMGentError("RUNTIME_INSTANCE_MISMATCH");
  }
  const config = await loadConfig(configPathOf());
  const controlledRoot = resolve(config.dataDir, "run", "backups");
  const source = resolve(controlledRoot, artifact);
  const within = relative(controlledRoot, source);
  if (within.startsWith("..") || resolve(controlledRoot, within) !== source) {
    throw new IMGentError("RUNTIME_INSTANCE_MISMATCH");
  }
  const sourceInfo = await lstat(source);
  if (
    !sourceInfo.isFile() ||
    sourceInfo.isSymbolicLink() ||
    (sourceInfo.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && sourceInfo.uid !== process.getuid())
  ) {
    throw new IMGentError("RUNTIME_INSTANCE_MISMATCH");
  }
  const output = resolve(outputPath);
  const temporary = `${output}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  try {
    await copyFile(source, temporary);
    await chmod(temporary, 0o600);
    await rename(temporary, output);
    return output;
  } finally {
    await rm(temporary, { force: true });
    await rm(source, { force: true });
  }
}

function nodeSupported(): boolean {
  const actual = process.versions.node.split(".").slice(0, 3).map(Number);
  const required = [24, 18, 0];
  for (let index = 0; index < required.length; index += 1) {
    if ((actual[index] ?? 0) > required[index]!) return true;
    if ((actual[index] ?? 0) < required[index]!) return false;
  }
  return true;
}

function print(value: unknown): void {
  const output = jsonOutput ? cliSuccessEnvelope(value, activeLocale) : value;
  stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

export async function runCli(): Promise<void> {
  try {
    jsonOutput = hasArgument("--json");
    activeLocale = await cliLocale();
    if (!nodeSupported()) {
      throw new IMGentError("RUNTIME_NODE_UNSUPPORTED");
    }
    await program.parseAsync();
  } catch (error) {
    if (
      error instanceof CommanderError &&
      (error.code === "commander.helpDisplayed" || error.code === "commander.version")
    ) {
      return;
    }
    const normalized =
      error instanceof CommanderError
        ? new IMGentError("CLI_USAGE_INVALID", {
            diagnostic: { commanderCode: error.code },
          })
        : normalizeError(error);
    if (jsonOutput) {
      stdout.write(`${JSON.stringify(cliErrorEnvelope(normalized.descriptor, activeLocale))}\n`);
    } else {
      process.stderr.write(`${renderErrorText(normalized.descriptor, activeLocale)}\n`);
    }
    process.exitCode = cliExitCode(normalized.descriptor);
  } finally {
    await Promise.allSettled([...offlineLeases.values()].reverse().map((lease) => lease.release()));
    offlineLeases.clear();
  }
}

async function cliLocale(): Promise<SupportedLocale> {
  const explicit = argumentValue("--locale");
  if (explicit !== undefined) {
    if (explicit !== "zh-CN" && explicit !== "en-US") {
      throw new IMGentError("LANGUAGE_UNSUPPORTED");
    }
    return explicit;
  }
  const environment = resolveLocale(
    [process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG],
    "zh-CN",
  );
  if (
    process.env.LC_ALL !== undefined ||
    process.env.LC_MESSAGES !== undefined ||
    process.env.LANG !== undefined
  ) {
    const matched = [process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG].find((value) =>
      normalizeLocale(value),
    );
    if (matched) {
      return normalizeLocale(matched) ?? environment;
    }
  }
  try {
    const config = await readRawConfig(configArgument());
    return config.defaultLocale;
  } catch {
    return "zh-CN";
  }
}

function configArgument(): string {
  return resolve(argumentValue("--config") ?? argumentValue("-c") ?? "imgent.json");
}

function argumentValue(name: string): string | undefined {
  const args = process.argv.slice(2);
  const prefix = `${name}=`;
  const inline = args.find((argument) => argument.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length);
  }
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasArgument(name: string): boolean {
  return process.argv
    .slice(2)
    .some((argument) => argument === name || argument.startsWith(`${name}=`));
}
