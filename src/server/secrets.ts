import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDataDir } from "./config.js";

/**
 * Mã hoá bí mật (API key, phiên Zalo) trước khi ghi xuống đĩa.
 * Khoá nằm ở data/secret.key — mất file này thì phải nhập lại các khoá.
 */
export class SecretBox {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("SecretBox cần khoá 32 byte");
  }

  static fromDataDir(dir = DATA_DIR): SecretBox {
    ensureDataDir();
    const file = path.join(dir, "secret.key");
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, crypto.randomBytes(32).toString("base64"), { mode: 0o600 });
    }
    return new SecretBox(Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64"));
  }

  encrypt(plain: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(".");
  }

  decrypt(sealed: string): string {
    const [version, iv, tag, data] = sealed.split(".");
    if (version !== "v1" || !iv || !tag || !data) throw new Error("Dữ liệu mã hoá không hợp lệ");
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
  }
}
