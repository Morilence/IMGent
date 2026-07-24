#!/usr/bin/env node
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { authorizeWechatIlink } from "@imgent/adapter-wechat-ilink";
import { IMGentError, normalizeError } from "@imgent/contracts";
import { Command, CommanderError, Option } from "commander";
import qrcode from "qrcode-terminal";
import { createBackup, restoreBackup } from "../backup/service.js";
import { defaultConfig } from "../config/index.js";
import { readRawConfig, updateConfig, writeConfig } from "../config/write.js";
import { normalizeLocale, renderError, renderErrorText, resolveLocale } from "../i18n/index.js";
import { IMGentApplication, renderReadiness } from "../runtime/application.js";
import { builtInSkillsDirectory } from "../skills/paths.js";
import { CURATION_SKILL, SkillRegistry } from "../skills/registry.js";
import { openAdminContext } from "./context.js";
import { cliErrorEnvelope, cliExitCode, cliSuccessEnvelope } from "./presentation.js";
import type {
  AgentProfile,
  BotInstance,
  ErrorDescriptor,
  SupportedLocale,
} from "@imgent/contracts";

const program = new Command();
let activeLocale: SupportedLocale = "zh-CN";
let jsonOutput = false;

program
  .name("imgent")
  .description("将 QQ 与微信 iLink 安全桥接到本地 Codex / Claude Code")
  .version("0.1.0")
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
    const workspace = resolve(options.workspace);
    await mkdir(workspace, { recursive: true });
    const config = {
      ...defaultConfig(workspace),
      dataDir: options.dataDir,
    };
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
    const { registry } = await configuredSkills();
    print(
      registry.all().map((skill) => ({
        name: skill.name,
        description: skill.description,
        source: skill.source,
        internal: skill.name === CURATION_SKILL,
        files: skill.files,
        bytes: skill.bytes,
      })),
    );
  });

skillsCommand
  .command("validate")
  .description("校验所有 skill 包和 AgentProfile 引用")
  .action(async () => {
    const { config, registry } = await configuredSkills();
    const profiles = config.agentProfiles.map((entry) => ({
      profileId: entry.id,
      skills: registry.visible(entry.skills, entry.memory.enabled).map((skill) => skill.name),
    }));
    print({
      result: "valid",
      skills: registry.all().length,
      profiles,
      restartRequiredAfterChanges: true,
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
        const context = await openAdminContext(configPath);
        try {
          await context.credentials.set(id, { appSecret: secret });
        } finally {
          context.store.close();
        }
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
      const context = await openAdminContext(configPath);
      try {
        await context.credentials.set(selected.credentialRef, {
          botToken: authorized.botToken,
        });
      } finally {
        context.store.close();
      }
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
    const context = await openAdminContext(configPathOf());
    try {
      print({
        result: "paired",
        ...context.identity.confirmPairing(code),
      });
    } finally {
      context.store.close();
    }
  });

const identity = program.command("identity").description("查看本地身份映射");
identity
  .command("list")
  .description("列出平台身份与 Principal")
  .action(async () => {
    const context = await openAdminContext(configPathOf());
    try {
      print(
        context.store.all(
          `SELECT pi.id AS platformIdentityId, pi.agent_profile_id AS agentProfileId,
                pi.platform, pi.bot_instance_id AS botInstanceId,
                pi.platform_user_id AS platformUserId, pi.principal_id AS principalId,
                pi.display_name AS displayName, pi.paired
         FROM platform_identities pi
         ORDER BY pi.created_at`,
        ),
      );
    } finally {
      context.store.close();
    }
  });

const group = program.command("group").description("管理 QQ 群授权");
group
  .command("list")
  .description("列出已发现群空间与授权状态")
  .action(async () => {
    const context = await openAdminContext(configPathOf());
    try {
      print(
        context.store.all(
          `SELECT cs.id AS conversationSpaceId, cs.agent_profile_id AS agentProfileId,
                cs.bot_instance_id AS botInstanceId,
                cs.platform_conversation_id AS platformConversationId,
                gp.mode, gp.platform_full_capability AS platformFullCapability,
                CASE WHEN ga.conversation_space_id IS NULL THEN 0 ELSE 1 END AS authorized
         FROM conversation_spaces cs
         JOIN group_policies gp ON gp.conversation_space_id = cs.id
         LEFT JOIN group_authorizations ga ON ga.conversation_space_id = cs.id
         WHERE cs.kind = 'group'
         ORDER BY cs.created_at`,
        ),
      );
    } finally {
      context.store.close();
    }
  });

group
  .command("authorize <conversation-space-id>")
  .description("由已配对 Principal 授权一个 QQ 群")
  .requiredOption("--principal <id>", "执行授权的已配对 Principal ID")
  .action(async (conversationSpaceId: string, options: { principal: string }) => {
    const context = await openAdminContext(configPathOf());
    try {
      context.identity.authorizeGroup(conversationSpaceId, options.principal);
      print({
        result: "group-authorized",
        conversationSpaceId,
        principalId: options.principal,
      });
    } finally {
      context.store.close();
    }
  });

program
  .command("doctor")
  .description("检查 Node、SQLite、平台和 Agent readiness")
  .action(async () => {
    const failures: ErrorDescriptor[] = [];
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
    let application: IMGentApplication | undefined;
    try {
      application = await IMGentApplication.create(configPathOf());
      const readiness = await application.checkReady();
      checks.push({
        check: "runtime",
        ok: readiness.ready,
        details: renderReadiness(readiness, activeLocale),
      });
      if (!readiness.ready) {
        failures.push(
          ...readiness.issues,
          ...Object.values(readiness.bots).flatMap((entry) => entry.issues),
          ...Object.values(readiness.profiles).flatMap((entry) => entry.issues),
        );
      }
    } catch (error) {
      const normalized = normalizeError(error);
      failures.push(normalized.descriptor);
      checks.push({
        check: "runtime",
        ok: false,
        details: renderError(normalized.descriptor, activeLocale),
      });
    } finally {
      await application?.stop();
    }
    print(checks);
    if (failures.length > 0) {
      process.exitCode = Math.max(...failures.map((failure) => cliExitCode(failure)));
    }
  });

program
  .command("status")
  .description("显示数据库积压、Bot 与 Agent readiness")
  .action(async () => {
    const application = await IMGentApplication.create(configPathOf());
    try {
      print({
        database: application.store.status(),
        transports: application.store.all(
          `SELECT bot_instance_id AS botInstanceId,
                  checkpoint_key AS checkpointKey, value, updated_at AS updatedAt
           FROM transport_checkpoints
           ORDER BY bot_instance_id, checkpoint_key`,
        ),
        lastInboundByBot: application.store.all(
          `SELECT bot_instance_id AS botInstanceId,
                  max(received_at) AS lastReceivedAt
           FROM inbound_events GROUP BY bot_instance_id
           ORDER BY bot_instance_id`,
        ),
        groups: application.store.all(
          `SELECT cs.bot_instance_id AS botInstanceId, gp.mode,
                  gp.platform_full_capability AS platformFullCapability,
                  count(*) AS count
           FROM group_policies gp
           JOIN conversation_spaces cs
             ON cs.id = gp.conversation_space_id
           GROUP BY cs.bot_instance_id, gp.mode, gp.platform_full_capability
           ORDER BY cs.bot_instance_id, gp.mode`,
        ),
        oldestWaitingTask:
          application.store.get(
            `SELECT id, conversation_key AS conversationKey, status,
                  created_at AS createdAt
           FROM tasks
           WHERE status IN ('queued', 'active', 'retry_wait', 'waiting_approval')
           ORDER BY created_at LIMIT 1`,
          ) ?? null,
        readiness: renderReadiness(await application.checkReady(), activeLocale),
      });
    } finally {
      await application.stop();
    }
  });

program
  .command("start")
  .description("执行 readiness 后启动所有启用的机器人实例")
  .action(async () => {
    const application = await IMGentApplication.create(configPathOf());
    try {
      await application.start();
      await Promise.race([once(process, "SIGINT"), once(process, "SIGTERM")]);
    } finally {
      await application.stop();
    }
  });

program
  .command("backup")
  .description("创建带 manifest 和校验和的一致性备份")
  .option("--output <file>", "备份文件路径")
  .action(async (options: { output?: string }) => {
    const output =
      options.output ?? resolve(`imgent-${new Date().toISOString().replaceAll(":", "-")}.backup`);
    print(await createBackup(configPathOf(), output));
  });

program
  .command("restore <file>")
  .description("验证并恢复备份到空数据目录")
  .requiredOption("--data-dir <path>", "目标数据目录")
  .option("--force", "明确覆盖已有目标", false)
  .action(async (file: string, options: { dataDir: string; force: boolean }) => {
    print(await restoreBackup(file, options.dataDir, configPathOf(), options.force));
  });

void main();

function configPathOf(): string {
  return resolve(program.opts<{ config: string }>().config);
}

async function configuredSkills(): Promise<{
  config: Awaited<ReturnType<typeof readRawConfig>>;
  registry: SkillRegistry;
}> {
  const configPath = configPathOf();
  const config = await readRawConfig(configPath);
  const registry = await SkillRegistry.load(
    await builtInSkillsDirectory(),
    resolve(dirname(configPath), config.dataDir, "skills"),
  );
  for (const profile of config.agentProfiles) registry.visible(profile.skills);
  return { config, registry };
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

async function main(): Promise<void> {
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
