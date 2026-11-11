import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "./db.js";
import { SecretBox } from "./secrets.js";
import { Settings } from "./settings.js";
import { Updater, changelogSection, compareVersions, isImportant, parseRelease, repoFromPackage, sumFor } from "./updates.js";

describe("hàm thuần", () => {
  it("so số bản", () => {
    expect(compareVersions("0.2.0", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.10")).toBeLessThan(0);
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
  });

  it("đọc repo từ package.json", () => {
    expect(repoFromPackage({ repository: { url: "git+https://github.com/a-b/tro-ly-cdn.git" } })).toEqual({ owner: "a-b", repo: "tro-ly-cdn" });
    expect(repoFromPackage({ repository: "github:x/y" })).toEqual({ owner: "x", repo: "y" });
    expect(repoFromPackage({})).toBeNull();
  });

  it("đọc bản phát hành, bỏ bản nháp và bản thử", () => {
    const base = {
      tag_name: "v0.2.0",
      body: "### Mới\n- Cập nhật một chạm",
      html_url: "https://github.com/x/y/releases/tag/v0.2.0",
      published_at: "2026-11-20T00:00:00Z",
      assets: [
        { name: "tro-ly-cdn-v0.2.0.tar.gz", browser_download_url: "https://dl/t.tar.gz" },
        { name: "SHA256SUMS", browser_download_url: "https://dl/sums" },
      ],
    };
    expect(parseRelease(base)).toMatchObject({ version: "0.2.0", tarballName: "tro-ly-cdn-v0.2.0.tar.gz", sumsUrl: "https://dl/sums" });
    expect(parseRelease({ ...base, draft: true })).toBeNull();
    expect(parseRelease({ ...base, prerelease: true })).toBeNull();
    expect(parseRelease({ ...base, tag_name: "ban-thu" })).toBeNull();
  });

  it("tách mục CHANGELOG và nhận ra Lưu ý", () => {
    const md = "# Nhật ký\n\n## [Chưa phát hành]\n\n## [0.2.0] - 2026-11-20\n### Mới\n- A\n### Lưu ý\n- Cần đăng nhập lại Zalo\n\n## [0.1.0] - 2026-11-10\n- Bản đầu\n";
    const s = changelogSection(md, "0.2.0");
    expect(s).toContain("- A");
    expect(s).not.toContain("Bản đầu");
    expect(isImportant(s)).toBe(true);
    expect(isImportant(changelogSection(md, "0.1.0"))).toBe(false);
    expect(changelogSection(md, "9.9.9")).toBe("");
  });

  it("tìm mã SHA256", () => {
    const h = "a".repeat(64);
    expect(sumFor(`${h}  tro-ly-cdn-v0.2.0.tar.gz\n${"b".repeat(64)}  khac.txt`, "tro-ly-cdn-v0.2.0.tar.gz")).toBe(h);
    expect(sumFor(`${h} *x.tar.gz`, "x.tar.gz")).toBe(h);
    expect(sumFor("rác", "x.tar.gz")).toBeNull();
  });
});

describe("Updater", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function setup(opts: { installDir?: boolean; tarball?: Buffer; sums?: (sha: string) => string; status?: number } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cdn-upd-"));
    dirs.push(root);
    const dataDir = path.join(root, "data");
    fs.mkdirSync(dataDir);
    const installDir = path.join(root, "install");
    fs.mkdirSync(path.join(installDir, "versions"), { recursive: true });
    const db = openDb(path.join(dataDir, "tro-ly.sqlite"));
    const settings = new Settings(db, new SecretBox(crypto.randomBytes(32)));
    const tarball = opts.tarball ?? Buffer.from("goi-cai-gia");
    const sha = crypto.createHash("sha256").update(tarball).digest("hex");
    const release = {
      tag_name: "v0.2.0",
      body: "### Mới\n- Thử",
      html_url: "u",
      published_at: "",
      assets: [
        { name: "tro-ly-cdn-v0.2.0.tar.gz", browser_download_url: "https://dl/t" },
        { name: "SHA256SUMS", browser_download_url: "https://dl/s" },
      ],
    };
    const fakeFetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u === "https://api/latest") return new Response(JSON.stringify(release), { status: opts.status ?? 200 });
      if (u === "https://dl/t") return new Response(tarball);
      if (u === "https://dl/s") return new Response(opts.sums ? opts.sums(sha) : `${sha}  tro-ly-cdn-v0.2.0.tar.gz\n`);
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    // Giả "tar" bằng cách tạo đúng file máy chủ cần; giả "npm ci" là không làm gì.
    const run = vi.fn(async (cmd: string, _args: string[], cwd: string) => {
      if (cmd === "tar") {
        fs.mkdirSync(path.join(cwd, "dist", "server"), { recursive: true });
        fs.writeFileSync(path.join(cwd, "dist", "server", "index.js"), "");
      }
    });
    const restart = vi.fn(async () => {});
    const onNewVersion = vi.fn();
    const updater = new Updater({
      current: "0.1.0",
      settings,
      db,
      dataDir,
      installDir: opts.installDir === false ? null : installDir,
      releaseUrl: "https://api/latest",
      fetch: fakeFetch,
      run,
      restart,
      onNewVersion,
    });
    return { updater, installDir, dataDir, run, restart, onNewVersion, db };
  }

  const waitFor = async (fn: () => boolean) => {
    for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
  };

  it("báo bản mới một lần, chỉ tự cập nhật khi có launcher", async () => {
    const t = setup({ installDir: false });
    await t.updater.check();
    await t.updater.check();
    expect(t.onNewVersion).toHaveBeenCalledTimes(1);
    const s = t.updater.status();
    expect(s.latest).toBe("0.2.0");
    expect(s.canSelfUpdate).toBe(false);
    expect(() => t.updater.apply()).toThrow(/launcher/);
    t.db.close();
  });

  it("repo riêng tư hoặc chưa có bản phát hành (404) thì im lặng", async () => {
    const t = setup({ status: 404 });
    expect(await t.updater.check()).toBeNull();
    expect(t.updater.status().latest).toBeNull();
    t.db.close();
  });

  it("cập nhật trọn vòng: giải nén, sao lưu DB, ghi chờ đổi bản, khởi động lại", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const t = setup();
    await t.updater.check();
    t.updater.apply();
    await vi.waitFor(() => expect(t.updater.status().state).toBe("restarting"));
    expect(fs.existsSync(path.join(t.installDir, "versions", "0.2.0", "dist", "server", "index.js"))).toBe(true);
    const pending = JSON.parse(fs.readFileSync(path.join(t.installDir, "update-pending.json"), "utf8"));
    expect(pending).toMatchObject({ from: "0.1.0", to: "0.2.0" });
    expect(fs.existsSync(pending.backup)).toBe(true);
    expect(t.run.mock.calls.map((c) => c[0])).toEqual(["tar", "npm"]);
    vi.advanceTimersByTime(2000);
    expect(t.restart).toHaveBeenCalled();
    t.db.close();
  });

  it("sai mã kiểm tra thì dừng, không đụng bản đang chạy", async () => {
    const t = setup({ sums: () => `${"0".repeat(64)}  tro-ly-cdn-v0.2.0.tar.gz` });
    await t.updater.check();
    t.updater.apply();
    await waitFor(() => t.updater.status().state === "error");
    const s = t.updater.status();
    expect(s.state).toBe("error");
    expect(s.error).toMatch(/không khớp/);
    expect(fs.existsSync(path.join(t.installDir, "versions", "0.2.0"))).toBe(false);
    expect(fs.existsSync(path.join(t.installDir, "update-pending.json"))).toBe(false);
    expect(t.restart).not.toHaveBeenCalled();
    t.db.close();
  });

  it("đọc kết quả lần trước của launcher và ẩn sau khi xem", () => {
    const t = setup();
    fs.writeFileSync(path.join(t.dataDir, "update-state.json"), JSON.stringify({ result: "rolled_back", from: "0.1.0", to: "0.2.0", at: Date.now(), error: "không lên" }));
    expect(t.updater.status().lastResult?.result).toBe("rolled_back");
    t.updater.dismissResult();
    expect(t.updater.status().lastResult).toBeNull();
    t.db.close();
  });
});
