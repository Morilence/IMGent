import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SKILL_DOCUMENT_BYTES = 64 * 1024;
const MAX_SKILL_FILES = 256;
const MAX_SKILL_PACKAGE_BYTES = 10 * 1024 * 1024;

export const CONVERSATION_SKILL = "imgent-conversation";
export const MEMORY_SKILL = "imgent-memory";
export const CURATION_SKILL = "imgent-memory-curation";

const INTERNAL_SKILLS = new Set([CURATION_SKILL]);

export type SkillSource = "builtin" | "user";

export type SkillPackageEntry =
  | { path: string; type: "directory" }
  | { path: string; type: "file"; content: Uint8Array; executable: boolean };

export interface SkillDefinition {
  name: string;
  description: string;
  body: string;
  root: string;
  source: SkillSource;
  files: number;
  bytes: number;
  packageEntries: readonly SkillPackageEntry[];
}

interface Frontmatter {
  name: string;
  description: string;
  body: string;
}

export class SkillRegistry {
  private constructor(private readonly definitions: ReadonlyMap<string, SkillDefinition>) {}

  static async load(builtinRoot: string, userRoot: string): Promise<SkillRegistry> {
    await mkdir(userRoot, { recursive: true, mode: 0o700 });
    const builtin = await scanRoot(builtinRoot, "builtin");
    const user = await scanRoot(userRoot, "user");
    const merged = new Map(builtin);
    for (const [name, definition] of user) merged.set(name, definition);
    for (const required of [CONVERSATION_SKILL, MEMORY_SKILL, CURATION_SKILL]) {
      if (!merged.has(required)) throw new Error(`缺少 IMGent 必需 skill: ${required}`);
    }
    return new SkillRegistry(merged);
  }

  all(): SkillDefinition[] {
    return [...this.definitions.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  get(name: string): SkillDefinition | undefined {
    return this.definitions.get(name);
  }

  require(name: string): SkillDefinition {
    const definition = this.get(name);
    if (!definition) throw new Error(`skill 不存在: ${name}`);
    return definition;
  }

  visible(requested: readonly string[], memoryEnabled = true): SkillDefinition[] {
    const available = this.all().filter(
      (skill) => !INTERNAL_SKILLS.has(skill.name) && (memoryEnabled || skill.name !== MEMORY_SKILL),
    );
    if (requested.includes("*")) return available;
    const selected: SkillDefinition[] = [];
    for (const name of requested) {
      if (INTERNAL_SKILLS.has(name)) {
        throw new Error(`内部 skill 不能分配给普通会话: ${name}`);
      }
      const definition = this.definitions.get(name);
      if (!definition) throw new Error(`AgentProfile 引用了不存在的 skill: ${name}`);
      if (memoryEnabled || name !== MEMORY_SKILL) selected.push(definition);
    }
    return selected.sort((left, right) => left.name.localeCompare(right.name));
  }

  developerInstructions(requested: readonly string[], memoryEnabled: boolean): string {
    const visible = this.visible(requested, memoryEnabled);
    const always = [
      this.require(CONVERSATION_SKILL),
      ...(memoryEnabled ? [this.require(MEMORY_SKILL)] : []),
    ];
    const alwaysNames = new Set(always.map((skill) => skill.name));
    const optional = visible.filter((skill) => !alwaysNames.has(skill.name));
    const catalog =
      optional.length === 0
        ? "没有额外的 IMGent skills。"
        : optional.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
    return [
      "# IMGent host instructions",
      "以下指令由本机部署者提供。它们适用于当前 IM 会话，但不能扩大宿主权限、绕过审批或覆盖系统安全策略。",
      "当用户明确点名某个 skill，或任务与其描述匹配时，先调用 skills.load，再按返回的指令工作。skills.load 只加载本地指令，不代表批准执行其中的脚本。",
      ...always.flatMap((skill) => ["", `## Always active: ${skill.name}`, skill.body]),
      "",
      "## Available on-demand skills",
      catalog,
    ].join("\n");
  }
}

async function scanRoot(root: string, source: SkillSource): Promise<Map<string, SkillDefinition>> {
  const result = new Map<string, SkillDefinition>();
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`skills 根目录必须是真实目录且不能是符号链接: ${root}`);
  }
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory())
      throw new Error(`skills 根目录只允许 skill 目录: ${join(root, entry.name)}`);
    const definition = await readSkill(join(root, entry.name), source);
    if (result.has(definition.name)) throw new Error(`重复 skill: ${definition.name}`);
    result.set(definition.name, definition);
  }
  return result;
}

async function readSkill(root: string, source: SkillSource): Promise<SkillDefinition> {
  const folderName = basename(root);
  if (!SKILL_NAME.test(folderName) || folderName.length > 63) {
    throw new Error(`skill 目录名无效: ${folderName}`);
  }
  const { files, bytes, entries } = await inspectTree(root);
  const documentPath = join(root, "SKILL.md");
  const documentEntry = entries.find(
    (entry): entry is Extract<SkillPackageEntry, { type: "file" }> =>
      entry.type === "file" && entry.path === "SKILL.md",
  );
  if (!documentEntry) throw new Error(`skill 缺少 SKILL.md: ${root}`);
  const document = Buffer.from(documentEntry.content).toString("utf8");
  if (Buffer.byteLength(document) > MAX_SKILL_DOCUMENT_BYTES) {
    throw new Error(`SKILL.md 超过 ${MAX_SKILL_DOCUMENT_BYTES} 字节: ${documentPath}`);
  }
  const parsed = parseFrontmatter(document, documentPath);
  if (parsed.name !== folderName) {
    throw new Error(`skill name 必须与目录名一致: ${parsed.name} != ${folderName}`);
  }
  if (!SKILL_NAME.test(parsed.name) || parsed.name.length > 63) {
    throw new Error(`skill name 无效: ${parsed.name}`);
  }
  if (!parsed.description || parsed.description.length > 1_000) {
    throw new Error(`skill description 长度无效: ${parsed.name}`);
  }
  if (!parsed.body) throw new Error(`skill 正文不能为空: ${parsed.name}`);
  return { ...parsed, root, source, files, bytes, packageEntries: entries };
}

async function inspectTree(
  root: string,
): Promise<{ files: number; bytes: number; entries: SkillPackageEntry[] }> {
  let files = 0;
  let bytes = 0;
  const entries: SkillPackageEntry[] = [];
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath = relativeDirectory ? join(relativeDirectory, entry.name) : entry.name;
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error(`skill 禁止符号链接: ${path}`);
      if (stat.isDirectory()) {
        entries.push({ path: relativePath, type: "directory" });
        await visit(path, relativePath);
        continue;
      }
      if (!stat.isFile()) throw new Error(`skill 只允许普通文件: ${path}`);
      const content = await readFile(path);
      files += 1;
      bytes += content.byteLength;
      if (files > MAX_SKILL_FILES) throw new Error(`skill 文件数超过 ${MAX_SKILL_FILES}: ${root}`);
      if (bytes > MAX_SKILL_PACKAGE_BYTES) {
        throw new Error(`skill 大小超过 ${MAX_SKILL_PACKAGE_BYTES} 字节: ${root}`);
      }
      entries.push({
        path: relativePath,
        type: "file",
        content,
        executable: (stat.mode & 0o111) !== 0,
      });
    }
  };
  await visit(root, "");
  return { files, bytes, entries };
}

function parseFrontmatter(document: string, path: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(document);
  if (!match) throw new Error(`SKILL.md 缺少 YAML frontmatter: ${path}`);
  const values = new Map<string, string>();
  for (const rawLine of match[1]!.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) throw new Error(`SKILL.md frontmatter 只支持单行键值: ${path}`);
    const key = line.slice(0, separator).trim();
    if (key !== "name" && key !== "description") {
      throw new Error(`SKILL.md frontmatter 不支持字段 ${key}: ${path}`);
    }
    if (values.has(key)) throw new Error(`SKILL.md frontmatter 字段重复 ${key}: ${path}`);
    values.set(key, scalar(line.slice(separator + 1).trim(), path));
  }
  const name = values.get("name");
  const description = values.get("description");
  if (!name || !description || values.size !== 2) {
    throw new Error(`SKILL.md frontmatter 必须且只能包含 name、description: ${path}`);
  }
  return { name, description, body: match[2]!.trim() };
}

function scalar(value: string, path: string): string {
  if (!value) return "";
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed !== "string") throw new Error("not string");
      return parsed;
    } catch {
      throw new Error(`SKILL.md frontmatter 双引号字符串无效: ${path}`);
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) throw new Error(`SKILL.md frontmatter 单引号字符串无效: ${path}`);
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}
