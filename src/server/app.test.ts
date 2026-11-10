import crypto from "node:crypto";
import { describe, expect, it, beforeEach } from "vitest";
import { buildApp } from "./app.js";
import { openDb } from "./db.js";
import { SecretBox } from "./secrets.js";
import { LoginLimiter, hashPassword, verifyPassword } from "./auth.js";
import { flattenConversation } from "../engines/types.js";
import { parseCodexJsonl, runCli } from "../engines/codex.js";

const newApp = () =>
  buildApp({ db: openDb(":memory:"), box: new SecretBox(crypto.randomBytes(32)) }).then(async (app) => {
    await app.ready();
    return app;
  });

const cookieOf = (res: { headers: Record<string, unknown> }) =>
  String(res.headers["set-cookie"] ?? "").split(";")[0];

describe("tài khoản quản trị", () => {
  it("lần đầu cho tạo admin, sau đó không cho tạo thêm", async () => {
    const app = await newApp();
    expect((await app.inject({ url: "/api/status" })).json()).toEqual({ hasAdmin: false, user: null });

    const setup = await app.inject({ method: "POST", url: "/api/setup", payload: { username: "chu", password: "matkhau123" } });
    expect(setup.statusCode).toBe(200);
    const status = await app.inject({ url: "/api/status", headers: { cookie: cookieOf(setup) } });
    expect(status.json().user).toEqual({ username: "chu" });

    const again = await app.inject({ method: "POST", url: "/api/setup", payload: { username: "ke-la", password: "matkhau123" } });
    expect(again.statusCode).toBe(409);
  });

  it("chặn API khi chưa đăng nhập và từ chối mật khẩu sai", async () => {
    const app = await newApp();
    await app.inject({ method: "POST", url: "/api/setup", payload: { username: "chu", password: "matkhau123" } });
    expect((await app.inject({ url: "/api/engine" })).statusCode).toBe(401);
    const bad = await app.inject({ method: "POST", url: "/api/login", payload: { username: "chu", password: "sai-roi-nhe" } });
    expect(bad.statusCode).toBe(401);
    const good = await app.inject({ method: "POST", url: "/api/login", payload: { username: "chu", password: "matkhau123" } });
    expect(good.statusCode).toBe(200);
  });

  it("mật khẩu ngắn bị từ chối", async () => {
    const app = await newApp();
    const r = await app.inject({ method: "POST", url: "/api/setup", payload: { username: "chu", password: "123" } });
    expect(r.statusCode).toBe(400);
  });
});

describe("cấu hình mô hình", () => {
  let app: Awaited<ReturnType<typeof newApp>>;
  let cookie: string;
  beforeEach(async () => {
    app = await newApp();
    cookie = cookieOf(await app.inject({ method: "POST", url: "/api/setup", payload: { username: "chu", password: "matkhau123" } }));
  });

  it("không bao giờ trả API key về trình duyệt, ô key trống thì giữ key cũ", async () => {
    const put = (body: object) => app.inject({ method: "PUT", url: "/api/engine", headers: { cookie }, payload: body });
    expect((await put({ kind: "anthropic-api", apiKey: "sk-ant-bi-mat" })).statusCode).toBe(200);
    await put({ kind: "anthropic-api", apiKey: "", model: "claude-sonnet-5-5" });

    const view = (await app.inject({ url: "/api/engine", headers: { cookie } })).json();
    expect(view.config).toMatchObject({ kind: "anthropic-api", model: "claude-sonnet-5-5", hasApiKey: true });
    expect(JSON.stringify(view)).not.toContain("sk-ant-bi-mat");
  });

  it("loại mô hình lạ bị từ chối", async () => {
    const r = await app.inject({ method: "PUT", url: "/api/engine", headers: { cookie }, payload: { kind: "hack" } });
    expect(r.statusCode).toBe(400);
  });

  it("chat khi chưa cấu hình mô hình báo lỗi dễ hiểu", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/profiles/1/chat",
      headers: { cookie },
      payload: { messages: [{ role: "user", content: "chào" }] },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/mô hình/);
  });
});

describe("tiện ích", () => {
  it("băm và kiểm mật khẩu", () => {
    const h = hashPassword("abc12345");
    expect(verifyPassword("abc12345", h)).toBe(true);
    expect(verifyPassword("abc12346", h)).toBe(false);
  });

  it("SecretBox mã hoá hai chiều và phát hiện sửa dữ liệu", () => {
    const box = new SecretBox(crypto.randomBytes(32));
    const sealed = box.encrypt("bí mật");
    expect(box.decrypt(sealed)).toBe("bí mật");
    const tampered = sealed.slice(0, -2) + (sealed.endsWith("A") ? "B" : "A") + sealed.slice(-1);
    expect(() => box.decrypt(tampered)).toThrow();
  });

  it("giới hạn đăng nhập sai", () => {
    const l = new LoginLimiter(2, 1000);
    l.fail("ip", 0);
    l.fail("ip", 10);
    expect(l.blocked("ip", 20)).toBe(true);
    expect(l.blocked("ip", 2000)).toBe(false);
  });

  it("gộp lịch sử hội thoại cho CLI", () => {
    expect(flattenConversation([{ role: "user", content: "a" }])).toBe("a");
    const p = flattenConversation([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ]);
    expect(p).toContain("Người dùng: a");
    expect(p).toContain("Trợ lý: b");
    expect(p.endsWith("c")).toBe(true);
  });

  it("không cho chèn lệnh shell qua tên model", async () => {
    await expect(runCli("codex", ["--model", "gpt & calc"], "", { timeoutMs: 1000 })).rejects.toThrow(/không hợp lệ/);
  });

  it("đọc câu trả lời cuối từ JSONL của codex", () => {
    const out = [
      '{"type":"thread.started","thread_id":"x"}',
      '{"type":"item.completed","item":{"id":"1","type":"reasoning","text":"nghĩ"}}',
      '{"type":"item.completed","item":{"id":"2","type":"agent_message","text":"Xin chào"}}',
      '{"type":"turn.completed"}',
    ].join("\n");
    expect(parseCodexJsonl(out)).toBe("Xin chào");
    expect(() => parseCodexJsonl('{"type":"error","message":"chưa đăng nhập"}')).toThrow(/chưa đăng nhập/);
  });
});

describe("tính cách và tài liệu", () => {
  it("tính cách mặc định có sẵn; tạo, chặn trùng nhãn; tải file, xem, xoá", async () => {
    const app = await newApp();
    const cookie = cookieOf(await app.inject({ method: "POST", url: "/api/setup", payload: { username: "chu", password: "matkhau123" } }));
    const list = (await app.inject({ url: "/api/profiles", headers: { cookie } })).json();
    expect(list.profiles.map((p: { tag: string }) => p.tag)).toEqual(["Bot CSKH"]);
    expect(list.offTag).toBe("Không bot");

    const base = { identity: { who: "Bạn là trợ lý công việc." }, sendMode: "auto", applies: "group", priority: 2 };
    const created = await app.inject({ method: "POST", url: "/api/profiles", headers: { cookie }, payload: { ...base, name: "Công việc", tag: "Bot Công việc" } });
    expect(created.statusCode).toBe(200);
    const dup = await app.inject({ method: "POST", url: "/api/profiles", headers: { cookie }, payload: { ...base, name: "Trùng", tag: "bot cskh" } });
    expect(dup.json().error).toMatch(/đã dùng/);
    const offClash = await app.inject({ method: "POST", url: "/api/profiles", headers: { cookie }, payload: { ...base, name: "X", tag: "Không bot" } });
    expect(offClash.statusCode).toBe(400);

    const pid = created.json().profile.id;
    const up = await app.inject({
      method: "POST",
      url: `/api/profiles/${pid}/files`,
      headers: { cookie },
      payload: { name: "C:/fakepath/bang-gia.txt", dataBase64: Buffer.from("Khoá A giá 1.999.000đ").toString("base64") },
    });
    expect(up.json()).toMatchObject({ name: "bang-gia.txt", chars: 21 });
    const one = (await app.inject({ url: `/api/profile-files/${up.json().id}`, headers: { cookie } })).json();
    expect(one.text).toBe("Khoá A giá 1.999.000đ");
    await app.inject({ method: "DELETE", url: `/api/profile-files/${up.json().id}`, headers: { cookie } });
    const after = (await app.inject({ url: "/api/profiles", headers: { cookie } })).json();
    expect(after.profiles.find((p: { id: number }) => p.id === pid).files).toHaveLength(0);

    const bad = await app.inject({ method: "POST", url: `/api/profiles/${pid}/files`, headers: { cookie }, payload: { name: "x.exe", dataBase64: "AA==" } });
    expect(bad.statusCode).toBe(400);
    const tooLong = await app.inject({
      method: "PUT",
      url: `/api/profiles/${pid}`,
      headers: { cookie },
      payload: { ...base, name: "Công việc", tag: "Bot Công việc", identity: { notes: "a".repeat(30_001) } },
    });
    expect(tooLong.statusCode).toBe(400);
  });

  it("nhiều tài khoản: dữ liệu tách riêng, sao chép tính cách sang tài khoản khác", async () => {
    const app = await newApp();
    const cookie = cookieOf(await app.inject({ method: "POST", url: "/api/setup", payload: { username: "chu", password: "matkhau123" } }));
    const acc2 = (await app.inject({ method: "POST", url: "/api/accounts", headers: { cookie }, payload: { name: "Nick CSKH" } })).json().account;
    const h2 = { cookie, "x-cdn-account": String(acc2.id) };
    expect((await app.inject({ url: "/api/profiles", headers: h2 })).json().profiles).toHaveLength(0);

    const p1 = (await app.inject({ url: "/api/profiles", headers: { cookie } })).json().profiles[0];
    await app.inject({
      method: "POST",
      url: `/api/profiles/${p1.id}/files`,
      headers: { cookie },
      payload: { name: "gia.txt", dataBase64: Buffer.from("Giá 1tr").toString("base64") },
    });
    // Đang ở tài khoản 2 thì không đụng được tính cách của tài khoản 1.
    expect((await app.inject({ method: "DELETE", url: `/api/profiles/${p1.id}`, headers: h2 })).statusCode).toBe(404);

    const copy = await app.inject({ method: "POST", url: "/api/profiles/copy", headers: { cookie }, payload: { profileIds: [p1.id], toAccountId: acc2.id } });
    expect(copy.json()).toEqual({ created: 1, updated: 0 });
    const again = await app.inject({ method: "POST", url: "/api/profiles/copy", headers: { cookie }, payload: { profileIds: [p1.id], toAccountId: acc2.id } });
    expect(again.json()).toEqual({ created: 0, updated: 1 });
    const copied = (await app.inject({ url: "/api/profiles", headers: h2 })).json().profiles;
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatchObject({ tag: "Bot CSKH", accountId: acc2.id });
    expect(copied[0].files.map((f: { name: string }) => f.name)).toEqual(["gia.txt"]);

    expect((await app.inject({ url: "/api/accounts", headers: { cookie } })).json().accounts).toHaveLength(2);
    expect((await app.inject({ method: "DELETE", url: `/api/accounts/${acc2.id}`, headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: "/api/accounts/1", headers: { cookie } })).json().error).toMatch(/ít nhất/);
  });
});
