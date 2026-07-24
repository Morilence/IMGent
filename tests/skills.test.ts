import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { defaultConfig } from "../src/config/index.js";
import { writeConfig } from "../src/config/write.js";
import { SkillHostTools } from "../src/skills/host-tools.js";
import { builtInSkillsDirectory } from "../src/skills/paths.js";
import { CONVERSATION_SKILL, MEMORY_SKILL, SkillRegistry } from "../src/skills/registry.js";

const execute = promisify(execFile);

test("SkillRegistry applies full user overrides and provider-independent profile filters", async () => {
  const directory = await mkdtemp(join(tmpdir(), "imgent-skills-registry-"));
  try {
    await writeSkill(
      directory,
      CONVERSATION_SKILL,
      "Local conversation policy",
      "Use the deployment-specific conversation policy.",
    );
    await writeSkill(directory, "release-check", "Check releases", "Run the release checklist.");
    const registry = await SkillRegistry.load(await builtInSkillsDirectory(), directory);
    assert.equal(registry.require(CONVERSATION_SKILL).source, "user");
    assert.match(registry.require(CONVERSATION_SKILL).body, /deployment-specific/);
    assert.deepEqual(
      registry.visible(["release-check"]).map((skill) => skill.name),
      ["release-check"],
    );
    assert.throws(() => registry.visible(["missing-skill"]), /不存在/);
    assert.match(registry.require(MEMORY_SKILL).body, /Interactive conversation mode/);
    assert.match(registry.require(MEMORY_SKILL).body, /Background curation mode/);
    assert.equal(registry.get("imgent-memory-curation"), undefined);
    const withoutMemory = registry.developerInstructions(["*"], false);
    assert.match(withoutMemory, /deployment-specific conversation policy/i);
    assert.match(withoutMemory, /release-check: Check releases/);
    assert.doesNotMatch(withoutMemory, /## Always active: imgent-memory/);
    assert.equal(
      registry.visible(["*"], false).some((skill) => skill.name === "imgent-memory"),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SkillRegistry rejects invalid frontmatter, traversal-like names, symlinks and oversized packages", async (t) => {
  await t.test("unknown or duplicate frontmatter fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "imgent-skills-invalid-"));
    try {
      const root = join(directory, "invalid-skill");
      await mkdir(root);
      await writeFile(
        join(root, "SKILL.md"),
        "---\nname: invalid-skill\nname: duplicate\ndescription: invalid\n---\nbody\n",
      );
      await assert.rejects(
        SkillRegistry.load(await builtInSkillsDirectory(), directory),
        /字段重复/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await t.test("unknown frontmatter fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "imgent-skills-frontmatter-"));
    try {
      const root = join(directory, "invalid-skill");
      await mkdir(root);
      await writeFile(
        join(root, "SKILL.md"),
        "---\nname: invalid-skill\ndescription: invalid\nmetadata: forbidden\n---\nbody\n",
      );
      await assert.rejects(
        SkillRegistry.load(await builtInSkillsDirectory(), directory),
        /不支持字段 metadata/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await t.test("directory traversal-like names", async () => {
    const directory = await mkdtemp(join(tmpdir(), "imgent-skills-name-"));
    try {
      await writeSkill(directory, "bad..name", "bad", "bad");
      await assert.rejects(
        SkillRegistry.load(await builtInSkillsDirectory(), directory),
        /目录名无效/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await t.test("symbolic links", async () => {
    const directory = await mkdtemp(join(tmpdir(), "imgent-skills-link-"));
    try {
      const root = await writeSkill(directory, "linked-skill", "linked", "body");
      await symlink(join(root, "SKILL.md"), join(root, "references.md"));
      await assert.rejects(
        SkillRegistry.load(await builtInSkillsDirectory(), directory),
        /禁止符号链接/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await t.test("package size", async () => {
    const directory = await mkdtemp(join(tmpdir(), "imgent-skills-large-"));
    try {
      const root = await writeSkill(directory, "large-skill", "large", "body");
      await writeFile(join(root, "asset.bin"), Buffer.alloc(10 * 1024 * 1024 + 1));
      await assert.rejects(
        SkillRegistry.load(await builtInSkillsDirectory(), directory),
        /大小超过/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await t.test("file count", async () => {
    const directory = await mkdtemp(join(tmpdir(), "imgent-skills-files-"));
    try {
      const root = await writeSkill(directory, "many-files", "many", "body");
      await Promise.all(
        Array.from({ length: 256 }, (_, index) => writeFile(join(root, `asset-${index}.txt`), "")),
      );
      await assert.rejects(
        SkillRegistry.load(await builtInSkillsDirectory(), directory),
        /文件数超过/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("skills.load materializes the immutable startup snapshot read-only and never runs scripts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "imgent-skills-load-"));
  try {
    const root = await writeSkill(
      directory,
      "workspace-guide",
      "Guide workspace work",
      "Read references/policy.md before acting.",
    );
    await mkdir(join(root, "references"));
    await writeFile(join(root, "references", "policy.md"), "startup snapshot\n");
    await mkdir(join(root, "scripts"));
    await writeFile(
      join(root, "scripts", "run.sh"),
      `#!/bin/sh\nprintf executed > ${JSON.stringify(join(directory, "executed"))}\n`,
      { mode: 0o700 },
    );
    await chmod(join(root, "scripts", "run.sh"), 0o700);

    const registry = await SkillRegistry.load(await builtInSkillsDirectory(), directory);
    await writeFile(join(root, "references", "policy.md"), "changed after startup\n");
    const tools = new SkillHostTools(registry);
    tools.register("turn-1", ["workspace-guide"]);
    const listed = await tools.handle({
      turnId: "turn-1",
      namespace: "skills",
      name: "list",
      arguments: {},
    });
    assert.equal(listed.success, true);
    assert.match(listed.text, /workspace-guide/);

    const loaded = await tools.handle({
      turnId: "turn-1",
      namespace: "skills",
      name: "load",
      arguments: { name: "workspace-guide" },
    });
    assert.equal(loaded.success, true);
    const payload = JSON.parse(loaded.text) as {
      instructions: string;
      resourceRoot: string;
    };
    assert.match(payload.instructions, /references\/policy\.md/);
    assert.equal(
      await readFile(join(payload.resourceRoot, "references", "policy.md"), "utf8"),
      "startup snapshot\n",
    );
    assert.equal(
      (await stat(join(payload.resourceRoot, "references", "policy.md"))).mode & 0o222,
      0,
    );
    await assert.rejects(access(join(directory, "executed")));
    await tools.unregister("turn-1");
    await assert.rejects(access(payload.resourceRoot));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("imgent skills init/list/validate manage only the local dataDir layer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "imgent-skills-cli-"));
  try {
    const configPath = join(directory, "imgent.json");
    await writeConfig(configPath, {
      ...defaultConfig(directory),
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
    const initialized = await execute(process.execPath, [
      wrapper,
      executable,
      "--config",
      configPath,
      "skills",
      "init",
      "deployment-guide",
      "--description",
      "Guide local deployments",
    ]);
    assert.match(initialized.stdout, /skill-initialized/);
    const created = join(directory, "state", "skills", "deployment-guide", "SKILL.md");
    assert.match(await readFile(created, "utf8"), /Guide local deployments/);

    const listed = await execute(process.execPath, [
      wrapper,
      executable,
      "--config",
      configPath,
      "skills",
      "list",
    ]);
    assert.match(listed.stdout, /deployment-guide/);
    assert.match(listed.stdout, /"source": "user"/);

    const validated = await execute(process.execPath, [
      wrapper,
      executable,
      "--config",
      configPath,
      "skills",
      "validate",
    ]);
    assert.match(validated.stdout, /"result": "valid"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function writeSkill(
  parent: string,
  name: string,
  description: string,
  body: string,
): Promise<string> {
  const root = join(parent, name);
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "SKILL.md"),
    ["---", `name: ${name}`, `description: ${JSON.stringify(description)}`, "---", body, ""].join(
      "\n",
    ),
  );
  return root;
}
