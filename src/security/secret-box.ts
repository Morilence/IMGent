import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SecretBox {
  constructor(private readonly key: Buffer) {
    if (key.byteLength !== 32) {
      throw new Error("SecretBox 密钥必须是 32 字节");
    }
  }

  encrypt(value: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
  }

  decrypt(value: Uint8Array): string {
    const data = Buffer.from(value);
    if (data[0] !== VERSION || data.byteLength < 1 + IV_BYTES + TAG_BYTES) {
      throw new Error("加密数据格式无效");
    }
    const iv = data.subarray(1, 1 + IV_BYTES);
    const tag = data.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
    const ciphertext = data.subarray(1 + IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }
}
