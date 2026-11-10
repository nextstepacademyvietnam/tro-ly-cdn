import type { DB } from "./db.js";
import type { SecretBox } from "./secrets.js";

/** Kho cấu hình dạng key → JSON. Giá trị `secret` được mã hoá bằng SecretBox. */
export class Settings {
  constructor(private readonly db: DB, private readonly box: SecretBox) {}

  get<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  }

  getSecret<T>(key: string): T | undefined {
    const sealed = this.get<string>(key);
    return sealed ? (JSON.parse(this.box.decrypt(sealed)) as T) : undefined;
  }

  setSecret(key: string, value: unknown): void {
    this.set(key, this.box.encrypt(JSON.stringify(value)));
  }
}
