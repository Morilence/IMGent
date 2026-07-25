import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const temporaryRoot = await mkdtemp(join(tmpdir(), "imgent-package-"));
const artifactsDirectory = join(temporaryRoot, "artifacts");
const installPrefix = join(temporaryRoot, "install");
const workspace = join(temporaryRoot, "workspace");
const configPath = join(temporaryRoot, "imgent.json");

async function run(file, args, options = {}) {
  return execute(file, args, {
    cwd: projectRoot,
    maxBuffer: 10 * 1024 * 1024,
    ...options,
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
      ...options.env,
    },
  });
}

try {
  await mkdir(workspace);
  let installSource;
  if (process.argv[2]) {
    if (process.argv[2].endsWith(".tgz")) {
      installSource = await realpath(resolve(process.argv[2]));
    } else {
      installSource = process.argv[2];
    }
  } else {
    await mkdir(artifactsDirectory);
    await run("corepack", ["pnpm", "pack", "--pack-destination", artifactsDirectory]);
    const archives = (await readdir(artifactsDirectory)).filter((name) => name.endsWith(".tgz"));
    if (archives.length !== 1) {
      throw new Error(`Expected one package archive, found ${archives.length}`);
    }
    installSource = join(artifactsDirectory, archives[0]);
  }

  await run("npm", ["install", "--global", "--prefix", installPrefix, installSource]);
  const npmRoot = (await run("npm", ["root", "--global", "--prefix", installPrefix])).stdout.trim();
  const installedPackageRoot = join(npmRoot, packageJson.name);
  const cliPath = join(installedPackageRoot, packageJson.bin.imgent);
  await access(cliPath);

  const installedPackageJson = JSON.parse(
    await readFile(join(installedPackageRoot, "package.json"), "utf8"),
  );
  if (
    installedPackageJson.author?.name !== "Morilence" ||
    installedPackageJson.author?.url !== "https://github.com/Morilence"
  ) {
    throw new Error("Installed package is missing the Morilence author metadata");
  }
  if (installedPackageJson.license !== "Apache-2.0") {
    throw new Error("Installed package is missing the Apache-2.0 license metadata");
  }
  const license = await readFile(join(installedPackageRoot, "LICENSE"), "utf8");
  if (!license.includes("Copyright 2026 Morilence")) {
    throw new Error("Installed package LICENSE is missing the Morilence copyright notice");
  }
  const notice = await readFile(join(installedPackageRoot, "NOTICE"), "utf8");
  if (!notice.includes("Copyright 2026 Morilence")) {
    throw new Error("Installed package is missing the Morilence copyright notice");
  }

  const binDirectory = process.platform === "win32" ? installPrefix : join(installPrefix, "bin");
  const binName = process.platform === "win32" ? "imgent.cmd" : "imgent";
  await access(join(binDirectory, binName));

  const cli = async (...args) =>
    run(process.execPath, [await realpath(cliPath), ...args], {
      cwd: temporaryRoot,
      env: {
        PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
      },
    });

  const version = (await cli("--version")).stdout.trim();
  if (version !== packageJson.version) {
    throw new Error(`Expected version ${packageJson.version}, received ${version}`);
  }
  await cli("--help");
  await cli(
    "--config",
    configPath,
    "--json",
    "init",
    "--workspace",
    workspace,
    "--data-dir",
    "./data",
  );
  const skills = JSON.parse((await cli("--config", configPath, "--json", "skills", "list")).stdout);
  const skillNames = skills.result.skills.map((skill) => skill.name);
  for (const expected of ["imgent-conversation", "imgent-memory"]) {
    if (!skillNames.includes(expected)) {
      throw new Error(`Installed package is missing built-in skill ${expected}`);
    }
  }

  process.stdout.write(
    `Verified ${packageJson.name}@${packageJson.version}: metadata, notices, global bin, CLI, and built-in skills\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
