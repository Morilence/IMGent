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

function defaultWait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForDistTags(readDistTags, accept, wait) {
  let lastError;
  let lastTags;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      lastTags = await readDistTags();
      lastError = undefined;
      if (accept(lastTags)) {
        return lastTags;
      }
    } catch (error) {
      lastError = error;
    }

    if (attempt < 5) {
      await wait(2 ** attempt * 1000);
    }
  }

  if (lastTags !== undefined) {
    return lastTags;
  }
  throw lastError;
}

export async function ensurePrereleaseDistTag({
  name,
  version,
  runNpm = defaultRunNpm,
  wait = defaultWait,
}) {
  const tag = prereleaseTagForVersion(version);
  if (tag === undefined) {
    return { tag: undefined, prereleaseLatest: false };
  }

  await runNpm(["dist-tag", "add", `${name}@${version}`, tag]);

  const readDistTags = async () => {
    const result = await runNpm(["view", `${name}@${tag}`, "dist-tags", "--json"]);
    return parseDistTags(result.stdout);
  };

  const tags = await waitForDistTags(
    readDistTags,
    (candidate) =>
      candidate[tag] === version &&
      !(
        typeof candidate.latest === "string" &&
        prereleaseTagForVersion(candidate.latest) !== undefined &&
        candidate.latest !== version
      ),
    wait,
  );

  if (tags[tag] !== version) {
    throw new Error(`Expected npm dist-tag ${tag} to point to ${version}`);
  }
  if (typeof tags.latest === "string" && prereleaseTagForVersion(tags.latest) !== undefined) {
    if (tags.latest !== version) {
      throw new Error(`npm dist-tag latest points to stale prerelease ${tags.latest}`);
    }
  }

  return { tag, prereleaseLatest: tags.latest === version };
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

  const latestResult = result.prereleaseLatest
    ? "; latest remains on the prerelease until the first stable release"
    : "";
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
