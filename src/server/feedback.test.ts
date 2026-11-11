import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { Auth, readablePassword } from "./auth.js";
import { openDb } from "./db.js";
import { SecretBox } from "./secrets.js";

const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers["set-cookie"] ?? "").split(";")[0];

async function setup(feedbackUrl: string | null, reply: { status?: number; body?: string } = {}) {
  const db = openDb(":memory:");
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(reply.body ?? '{"ok":true}', { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
  const app = await buildApp({ db, box: new SecretBox(crypto.randomBytes(32)), feedbackUrl, feedbackFetch: fakeFetch, version: "0.2.0" });
  await app.ready();
  const res = await app.inject({ method: "POST", url: "/api/setup", payload: { username: "chu", password: "matkhau123" } });
  return { app, db, sent, cookie: cookieOf(res) };
}

describe("đặt lại mật khẩu", () => {
  it("đổi mật khẩu, giữ tên, đăng xuất mọi phiên", async () => {
    const t = await setup(null);
    const pw = readablePassword();
    expect(pw).toMatch(/^[a-z]+-\d{4}-[a-z]+$/);
    expect(new Auth(t.db).resetPassword(pw)).toBe("chu");
    expect((await t.app.inject({ url: "/api/status", headers: { cookie: t.cookie } })).json().user).toBeNull();
    expect((await t.app.inject({ method: "POST", url: "/api/login", payload: { username: "chu", password: "matkhau123" } })).statusCode).toBe(401);
    expect((await t.app.inject({ method: "POST", url: "/api/login", payload: { username: "chu", password: pw } })).statusCode).toBe(200);
    expect(() => new Auth(t.db).resetPassword("ngan")).toThrow(/8 ký tự/);
  });

  it("chưa có tài khoản thì không làm gì", () => {
    expect(new Auth(openDb(":memory:")).resetPassword("matkhau-moi-1")).toBeNull();
  });
});

describe("báo lỗi", () => {
  it("gửi tới nơi nhận, chỉ kèm thông tin máy khi được cho phép", async () => {
    const t = await setup("https://script.google.com/macros/s/abc/exec");
    const post = (payload: object) => t.app.inject({ method: "POST", url: "/api/feedback", headers: { cookie: t.cookie }, payload });
    expect((await post({ kind: "bug", message: "Gửi nháp bị lỗi", contact: "0912345678", includeInfo: true, page: "Hộp thư", screenshot: "data:image/jpeg;base64,AAAA" })).statusCode).toBe(200);
    expect(t.sent[0]!.body).toMatchObject({ kind: "Báo lỗi", message: "Gửi nháp bị lỗi", contact: "0912345678", version: "0.2.0", page: "Hộp thư", screenshot: "AAAA" });
    await post({ kind: "idea", message: "Thêm lọc theo nhãn", includeInfo: false });
    expect(t.sent[1]!.body).toMatchObject({ kind: "Góp ý" });
    expect(t.sent[1]!.body).not.toHaveProperty("version");
    expect(t.sent[1]!.body).not.toHaveProperty("page");
  });

  it("chặn nội dung quá ngắn, chưa đăng nhập, chưa đặt nơi nhận, nơi nhận lỗi", async () => {
    const t = await setup("https://x/exec", { body: "<html>lỗi</html>" });
    expect((await t.app.inject({ method: "POST", url: "/api/feedback", payload: { message: "lỗi rồi nè" } })).statusCode).toBe(401);
    expect((await t.app.inject({ method: "POST", url: "/api/feedback", headers: { cookie: t.cookie }, payload: { message: "ơ" } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: "POST", url: "/api/feedback", headers: { cookie: t.cookie }, payload: { message: "lỗi rồi nè" } })).statusCode).toBe(502);
    const off = await setup(null);
    expect((await off.app.inject({ url: "/api/feedback/config", headers: { cookie: off.cookie } })).json()).toEqual({ enabled: false });
    expect((await off.app.inject({ method: "POST", url: "/api/feedback", headers: { cookie: off.cookie }, payload: { message: "lỗi rồi nè" } })).statusCode).toBe(400);
  });
});
