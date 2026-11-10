import crypto from "node:crypto";
import type { DB } from "./db.js";

const SESSION_DAYS = 30;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = crypto.scryptSync(password, Buffer.from(salt, "base64"), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export class Auth {
  constructor(private readonly db: DB) {}

  hasAdmin(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM users LIMIT 1").get());
  }

  createAdmin(username: string, password: string): number {
    if (this.hasAdmin()) throw new Error("Đã có tài khoản quản trị");
    validateCredentials(username, password);
    const r = this.db
      .prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)")
      .run(username.trim(), hashPassword(password), Date.now());
    return Number(r.lastInsertRowid);
  }

  login(username: string, password: string): string | null {
    const user = this.db
      .prepare("SELECT id, password_hash FROM users WHERE username = ?")
      .get(username.trim()) as { id: number; password_hash: string } | undefined;
    if (!user || !verifyPassword(password, user.password_hash)) return null;
    return this.startSession(user.id);
  }

  startSession(userId: number): string {
    const token = crypto.randomBytes(32).toString("base64url");
    this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
    this.db
      .prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .run(sha256(token), userId, Date.now() + SESSION_DAYS * 86_400_000);
    return token;
  }

  userForToken(token: string | undefined): { id: number; username: string } | null {
    if (!token) return null;
    const row = this.db
      .prepare(
        `SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(sha256(token), Date.now()) as { id: number; username: string } | undefined;
    return row ?? null;
  }

  logout(token: string | undefined): void {
    if (token) this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  }
}

export function validateCredentials(username: string, password: string): void {
  if (!/^[\p{L}\p{N}._-]{3,32}$/u.test(username.trim())) {
    throw new Error("Tên đăng nhập 3–32 ký tự, chỉ gồm chữ, số, dấu chấm, gạch");
  }
  if (password.length < 8) throw new Error("Mật khẩu cần ít nhất 8 ký tự");
}

/** Chặn dò mật khẩu: tối đa 10 lần sai mỗi 15 phút cho một địa chỉ. */
export class LoginLimiter {
  private readonly fails = new Map<string, number[]>();
  constructor(private readonly max = 10, private readonly windowMs = 15 * 60_000) {}

  blocked(key: string, now = Date.now()): boolean {
    const list = (this.fails.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.fails.set(key, list);
    return list.length >= this.max;
  }

  fail(key: string, now = Date.now()): void {
    this.fails.set(key, [...(this.fails.get(key) ?? []), now]);
  }

  reset(key: string): void {
    this.fails.delete(key);
  }
}
