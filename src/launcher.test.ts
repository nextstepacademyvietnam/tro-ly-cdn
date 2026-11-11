import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/** Bản app giả: trả /api/status đúng số bản; có file do-update thì giả vờ chuẩn bị bản 0.2.0 rồi thoát mã 75. */
const fakeApp = (version: string, broken = false) => `
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
${broken ? "process.exit(1);" : ""}
const root = process.env.CDN_INSTALL_DIR;
http.createServer((q, s) => { s.setHeader("content-type", "application/json"); s.end(JSON.stringify({ version: "${version}" })); })
  .listen(Number(process.env.PORT), "127.0.0.1", () => {
    const m = path.join(root, "do-update");
    if (fs.existsSync(m)) {
      fs.rmSync(m);
      fs.writeFileSync(path.join(root, "update-pending.json"), JSON.stringify({ from: "${version}", to: "0.2.0", backup: path.join(root, "backup.sqlite") }));
      setTimeout(() => process.exit(75), 200);
    }
  });
`;

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });

const until = async (fn: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

describe("launcher.mjs", () => {
  const procs: ChildProcess[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const p of procs.splice(0)) {
      if (p.exitCode === null) {
        const done = new Promise((r) => p.once("exit", r));
        // Windows: kill() chỉ tắt launcher, app con vẫn chạy và giữ thư mục bản → tắt cả cây tiến trình.
        if (process.platform === "win32" && p.pid) spawnSync("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore" });
        else p.kill();
        await done;
      }
    }
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  async function setup(newIsBroken: boolean) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cdn-launch-"));
    dirs.push(root);
    fs.copyFileSync(path.resolve("launcher.mjs"), path.join(root, "launcher.mjs"));
    for (const [v, broken] of [["0.1.0", false], ["0.2.0", newIsBroken]] as const) {
      const dir = path.join(root, "versions", v, "dist", "server");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "index.js"), fakeApp(v, broken));
    }
    fs.writeFileSync(path.join(root, "current.json"), JSON.stringify({ version: "0.1.0", previous: null }));
    fs.mkdirSync(path.join(root, "data"));
    fs.writeFileSync(path.join(root, "data", "tro-ly.sqlite"), "du-lieu-sau-khi-nang-cap");
    fs.writeFileSync(path.join(root, "backup.sqlite"), "du-lieu-sao-luu");
    fs.writeFileSync(path.join(root, "do-update"), "");
    const port = await freePort();
    const p = spawn(process.execPath, [path.join(root, "launcher.mjs")], {
      env: { ...process.env, PORT: String(port), CDN_DATA_DIR: path.join(root, "data"), CDN_HEALTH_TIMEOUT_MS: "3000" },
      stdio: "ignore",
    });
    procs.push(p);
    const state = () => {
      try {
        return JSON.parse(fs.readFileSync(path.join(root, "data", "update-state.json"), "utf8"));
      } catch {
        return null;
      }
    };
    const current = () => JSON.parse(fs.readFileSync(path.join(root, "current.json"), "utf8"));
    return { root, port, state, current };
  }

  it("mã 75: đổi sang bản mới khi bản mới trả lời đúng", async () => {
    const t = await setup(false);
    expect(await until(() => t.state()?.result === "ok")).toBe(true);
    expect(t.current()).toEqual({ version: "0.2.0", previous: "0.1.0" });
    expect(fs.existsSync(path.join(t.root, "update-pending.json"))).toBe(false);
    const res = await fetch(`http://127.0.0.1:${t.port}/api/status`);
    expect((await res.json()).version).toBe("0.2.0");
  }, 30_000);

  it("bản mới không lên: quay về bản cũ và chép lại dữ liệu sao lưu", async () => {
    const t = await setup(true);
    expect(await until(() => t.state()?.result === "rolled_back")).toBe(true);
    expect(t.current().version).toBe("0.1.0");
    expect(fs.existsSync(path.join(t.root, "versions", "0.2.0"))).toBe(false);
    expect(t.state().error).toMatch(/dừng ngay/);
    expect(fs.readFileSync(path.join(t.root, "data", "tro-ly.sqlite"), "utf8")).toBe("du-lieu-sao-luu");
    expect(
      await until(() => {
        void fetch(`http://127.0.0.1:${t.port}/api/status`)
          .then((r) => r.json())
          .then((j) => ((globalThis as { v?: string }).v = j.version))
          .catch(() => undefined);
        return (globalThis as { v?: string }).v === "0.1.0";
      }),
    ).toBe(true);
  }, 30_000);
});
