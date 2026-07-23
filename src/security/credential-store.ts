import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SecretBox } from "./secret-box.js";

const REF = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export class CredentialStore {
  private box?: SecretBox;

  constructor(private readonly dataDir: string) {}

  private validateRef(ref: string): void {
    if (!REF.test(ref)) {
      throw new Error("credentialRef 格式无效");
    }
  }

  async secretBox(): Promise<SecretBox> {
    if (this.box) return this.box;
    const directory = join(this.dataDir, "credentials");
    const keyPath = join(this.dataDir, "credentials.key");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let key: Buffer;
    try {
      key = await readFile(keyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      key = randomBytes(32);
      await writeFile(keyPath, key, { mode: 0o600, flag: "wx" });
    }
    await chmod(keyPath, 0o600);
    this.box = new SecretBox(key);
    return this.box;
  }

  async set(ref: string, value: Record<string, unknown>): Promise<void> {
    this.validateRef(ref);
    const directory = join(this.dataDir, "credentials");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const finalPath = join(directory, `${ref}.enc`);
    const temporaryPath = join(directory, `.${ref}.${process.pid}.tmp`);
    const encrypted = (await this.secretBox()).encrypt(JSON.stringify(value));
    await writeFile(temporaryPath, encrypted, { mode: 0o600, flag: "wx" });
    await rename(temporaryPath, finalPath);
    await chmod(finalPath, 0o600);
  }

  async get<T extends object>(ref: string): Promise<T | undefined> {
    this.validateRef(ref);
    try {
      const encrypted = await readFile(join(this.dataDir, "credentials", `${ref}.enc`));
      return JSON.parse((await this.secretBox()).decrypt(encrypted)) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async has(ref: string): Promise<boolean> {
    return (await this.get(ref)) !== undefined;
  }
}
