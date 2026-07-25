import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const scriptPath = fileURLToPath(import.meta.url);

export function prereleaseTagForVersion(version) {
  const match =
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-([0-9A-Za-z-]+)(?:\.[0-9A-Za-z-]+)*(?:\+[0-9A-Za-z.-]+)?$/.exec(
      version,
    );
  return match?.[1];
}

function parseDistTags(stdout) {
  const parsed = JSON.parse(stdout);
  const tags = Array.isArray(parsed) ? parsed[0] : parsed;
  if (tags === null || typeof tags !== "object" || Array.isArray(tags)) {
    throw new Error("npm returned an invalid dist-tag response");
  }
  return tags;
}

async function defaultRunNpm(args) {
  return execute("npm", args, {
    cwd: projectRoot,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
    },
  });
}

export async function ensurePrereleaseDistTag({ name, version, runNpm = defaultRunNpm }) {
  const tag = prereleaseTagForVersion(version);
  if (tag === undefined) {
    return { tag: undefined, removedLatest: false };
  }

  await runNpm(["dist-tag", "add", `${name}@${version}`, tag]);

  const readDistTags = async () => {
    const result = await runNpm(["view", `${name}@${tag}`, "dist-tags", "--json"]);
    return parseDistTags(result.stdout);
  };

  let tags = await readDistTags();
  let removedLatest = false;
  if (typeof tags.latest === "string" && prereleaseTagForVersion(tags.latest) !== undefined) {
    await runNpm(["dist-tag", "rm", name, "latest"]);
    removedLatest = true;
    tags = await readDistTags();
  }

  if (tags[tag] !== version) {
    throw new Error(`Expected npm dist-tag ${tag} to point to ${version}`);
  }
  if (typeof tags.latest === "string" && prereleaseTagForVersion(tags.latest) !== undefined) {
    throw new Error(`npm dist-tag latest still points to prerelease ${tags.latest}`);
  }

  return { tag, removedLatest };
}

async function main() {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const result = await ensurePrereleaseDistTag({
    name: packageJson.name,
    version: packageJson.version,
  });

  if (result.tag === undefined) {
    process.stdout.write(
      `Verified ${packageJson.name}@${packageJson.version}: stable release tags unchanged\n`,
    );
    return;
  }

  const latestResult = result.removedLatest ? "; removed prerelease latest tag" : "";
  process.stdout.write(
    `Verified ${packageJson.name}@${packageJson.version}: ${result.tag} dist-tag${latestResult}\n`,
  );
}

if (process.argv[1] === scriptPath) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Failed to reconcile npm dist-tags: ${message}\n`);
    process.exitCode = 1;
  });
}
