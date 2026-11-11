import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { DB } from "./db.js";
import type { Settings } from "./settings.js";

/**
 * Kiểm tra và cài bản mới từ GitHub Releases.
 *
 * Chỉ hỏi GitHub "bản mới nhất là gì" — không gửi dữ liệu nào của người dùng.
 * Tự cập nhật chỉ chạy khi app được bật qua launcher.mjs (biến CDN_INSTALL_DIR):
 * bản mới giải nén vào versions/<số bản>, sao lưu DB, rồi thoát mã 75 để launcher đổi bản.
 * Launcher kiểm bản mới có lên không; không lên thì quay về bản cũ và chép lại DB.
 */

export const RESTART_EXIT_CODE = 75;
const CHECK_EVERY_MS = 6 * 3_600_000;

export interface ReleaseInfo {
  version: string;
  notes: string;
  url: string;
  publishedAt: string;
  tarballUrl: string | null;
  tarballName: string | null;
  sumsUrl: string | null;
}

export type UpdateStep = "idle" | "downloading" | "verifying" | "installing" | "backing_up" | "restarting" | "error";

/** Kết quả lần cập nhật trước, launcher ghi vào data/update-state.json. */
export interface LastResult {
  result: "ok" | "rolled_back";
  from: string;
  to: string;
  at: number;
  error?: string;
}

// ---------- Hàm thuần ----------

/** So số bản dạng 1.2.3 (bỏ chữ v đầu). Dương nếu a mới hơn b. Phần đuôi -beta coi là cũ hơn bản chính. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main, pre = ""] = v.trim().replace(/^v/i, "").split("-", 2);
    const nums = main!.split(".").map((n) => Number.parseInt(n, 10) || 0);
    while (nums.length < 3) nums.push(0);
    return { nums, pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i]! - y.nums[i]!;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** owner/repo từ trường repository của package.json (chuỗi hoặc { url }). */
export function repoFromPackage(pkg: { repository?: string | { url?: string } }): { owner: string; repo: string } | null {
  const raw = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  if (!raw) return null;
  const m = raw.match(/github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[#?].*)?$/i) ?? raw.match(/^(?:github:)?([\w.-]+)\/([\w.-]+)$/);
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

/** Đọc trả lời /releases/latest của GitHub. Bỏ bản nháp, bản thử. */
export function parseRelease(json: unknown): ReleaseInfo | null {
  const r = json as {
    tag_name?: string;
    body?: string;
    html_url?: string;
    published_at?: string;
    draft?: boolean;
    prerelease?: boolean;
    assets?: { name: string; browser_download_url: string }[];
  };
  if (!r || typeof r.tag_name !== "string" || r.draft || r.prerelease) return null;
  const version = r.tag_name.replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+/.test(version)) return null;
  const assets = r.assets ?? [];
  const tarball = assets.find((a) => /\.tar\.gz$/i.test(a.name));
  const sums = assets.find((a) => a.name === "SHA256SUMS");
  return {
    version,
    notes: (r.body ?? "").trim(),
    url: r.html_url ?? "",
    publishedAt: r.published_at ?? "",
    tarballUrl: tarball?.browser_download_url ?? null,
    tarballName: tarball?.name ?? null,
    sumsUrl: sums?.browser_download_url ?? null,
  };
}

/** Lấy mục của một bản trong CHANGELOG.md (từ "## [x.y.z]" tới mục kế tiếp). */
export function changelogSection(md: string, version: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => new RegExp(`^## \\[?v?${version.replace(/\./g, "\\.")}\\]?(\\s|$)`).test(l));
  if (start < 0) return "";
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join("\n").trim();
}

/** Bản có mục "Lưu ý" thì thanh báo không cho ẩn. */
export const isImportant = (notes: string) => /^#{2,4}\s*Lưu ý/im.test(notes);

/** Tìm mã SHA256 của một file trong nội dung SHA256SUMS ("<hex>  <tên>"). */
export function sumFor(sums: string, name: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const m = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (m && m[2]!.trim() === name) return m[1]!.toLowerCase();
  }
  return null;
}

// ---------- Bộ cập nhật ----------

export interface UpdaterOptions {
  current: string;
  settings: Settings;
  db: DB;
  dataDir: string;
  /** Thư mục cài của launcher; không có thì chỉ báo bản mới, không tự cập nhật. */
  installDir?: string | null;
  releaseUrl: string | null;
  fetch?: typeof fetch;
  /** Chạy lệnh (npm ci, tar). Thay được khi test. */
  run?: (cmd: string, args: string[], cwd: string) => Promise<void>;
  /** Tắt app gọn gàng rồi thoát mã 75. */
  restart?: () => Promise<void>;
  /** Gọi một lần cho mỗi bản mới tìm thấy (ghi chuông). */
  onNewVersion?: (r: ReleaseInfo) => void;
  log?: (msg: string, extra?: object) => void;
}

export class Updater {
  private step: UpdateStep = "idle";
  private error = "";
  private timer: NodeJS.Timeout | null = null;
  private checking: Promise<ReleaseInfo | null> | null = null;

  constructor(private readonly o: UpdaterOptions) {}

  get canSelfUpdate(): boolean {
    return Boolean(this.o.installDir);
  }

  private get latest(): ReleaseInfo | null {
    return this.o.settings.get<ReleaseInfo>("update.latest") ?? null;
  }

  lastResult(): LastResult | null {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(this.o.dataDir, "update-state.json"), "utf8")) as LastResult;
      const seen = this.o.settings.get<number>("update.resultSeenAt") ?? 0;
      return r.at > seen ? r : null;
    } catch {
      return null;
    }
  }

  dismissResult() {
    this.o.settings.set("update.resultSeenAt", Date.now());
  }

  status() {
    const latest = this.latest;
    const newer = latest && compareVersions(latest.version, this.o.current) > 0 ? latest : null;
    return {
      current: this.o.current,
      latest: newer?.version ?? null,
      notes: newer?.notes ?? "",
      url: newer?.url ?? "",
      publishedAt: newer?.publishedAt ?? "",
      important: newer ? isImportant(newer.notes) : false,
      canSelfUpdate: this.canSelfUpdate && Boolean(newer?.tarballUrl && newer?.sumsUrl),
      checkedAt: this.o.settings.get<number>("update.checkedAt") ?? 0,
      checkEnabled: Boolean(this.o.releaseUrl),
      state: this.step,
      error: this.error,
      lastResult: this.lastResult(),
    };
  }

  start() {
    if (!this.o.releaseUrl || this.timer) return;
    const tick = () => void this.check().catch((err) => this.o.log?.("Không kiểm tra được bản mới", { err: (err as Error).message }));
    setTimeout(tick, 20_000).unref();
    this.timer = setInterval(tick, CHECK_EVERY_MS);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Hỏi GitHub bản mới nhất. Lỗi mạng thì ném lỗi, giữ kết quả cũ. */
  check(): Promise<ReleaseInfo | null> {
    if (!this.o.releaseUrl) return Promise.resolve(null);
    this.checking ??= this.doCheck().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private async doCheck(): Promise<ReleaseInfo | null> {
    const f = this.o.fetch ?? fetch;
    const res = await f(this.o.releaseUrl!, {
      headers: { accept: "application/vnd.github+json", "user-agent": "tro-ly-cdn-updater" },
      signal: AbortSignal.timeout(15_000),
    });
    this.o.settings.set("update.checkedAt", Date.now());
    if (res.status === 404) return null; // chưa có bản phát hành nào, hoặc repo riêng tư
    if (!res.ok) throw new Error(`GitHub trả lỗi ${res.status}`);
    const info = parseRelease(await res.json());
    if (!info) return null;
    this.o.settings.set("update.latest", info);
    if (compareVersions(info.version, this.o.current) > 0 && this.o.settings.get<string>("update.notified") !== info.version) {
      this.o.settings.set("update.notified", info.version);
      this.o.onNewVersion?.(info);
    }
    return info;
  }

  /** Bắt đầu cập nhật (chạy nền). Ném lỗi ngay nếu không cập nhật được. */
  apply(): void {
    const latest = this.latest;
    if (!this.canSelfUpdate) throw new Error("App không chạy qua launcher nên không tự cập nhật được.");
    if (!latest || compareVersions(latest.version, this.o.current) <= 0) throw new Error("Đang dùng bản mới nhất.");
    if (!latest.tarballUrl || !latest.sumsUrl || !latest.tarballName) throw new Error("Bản phát hành thiếu gói cài.");
    if (this.step !== "idle" && this.step !== "error") throw new Error("Đang cập nhật.");
    this.error = "";
    void this.doApply(latest).catch((err) => {
      this.step = "error";
      this.error = (err as Error).message;
      this.o.log?.("Cập nhật lỗi", { err: this.error });
    });
  }

  private async doApply(r: ReleaseInfo) {
    const f = this.o.fetch ?? fetch;
    const install = this.o.installDir!;
    const versionsDir = path.join(install, "versions");
    const target = path.join(versionsDir, r.version);
    const tmp = path.join(versionsDir, `.tai-${r.version}`);

    this.step = "downloading";
    const get = async (url: string) => {
      const res = await f(url, { headers: { "user-agent": "tro-ly-cdn-updater" }, signal: AbortSignal.timeout(300_000) });
      if (!res.ok) throw new Error(`Không tải được gói cài (lỗi ${res.status})`);
      return Buffer.from(await res.arrayBuffer());
    };
    const tarball = await get(r.tarballUrl!);
    const sums = (await get(r.sumsUrl!)).toString("utf8");

    this.step = "verifying";
    const expected = sumFor(sums, r.tarballName!);
    const actual = crypto.createHash("sha256").update(tarball).digest("hex");
    if (!expected || expected !== actual) throw new Error("Gói cài tải về không khớp mã kiểm tra — đã dừng, bản đang chạy không đổi.");

    this.step = "installing";
    const run = this.o.run ?? runCommand;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    const file = path.join(tmp, r.tarballName!);
    fs.writeFileSync(file, tarball);
    await run("tar", ["-xzf", r.tarballName!], tmp);
    fs.rmSync(file);
    if (!fs.existsSync(path.join(tmp, "dist", "server", "index.js"))) throw new Error("Gói cài thiếu dist/server/index.js");
    await run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], tmp);
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(tmp, target);

    this.step = "backing_up";
    const backups = path.join(this.o.dataDir, "backups");
    fs.mkdirSync(backups, { recursive: true });
    // Giờ máy (không phải UTC) để người dùng nhận ra bản sao lưu lúc nào: 20261111-0944.
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
    const backup = path.join(backups, `truoc-${r.version}-${stamp}.sqlite`);
    this.o.db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);

    fs.writeFileSync(path.join(install, "update-pending.json"), JSON.stringify({ from: this.o.current, to: r.version, backup }, null, 2));
    this.step = "restarting";
    this.o.log?.(`Đã chuẩn bị bản ${r.version}, khởi động lại để đổi bản`);
    // Chờ một nhịp cho web kịp đọc trạng thái "restarting".
    setTimeout(() => void this.o.restart?.(), 1500).unref();
  }
}

/** Chạy lệnh, lỗi thì kèm vài dòng cuối của đầu ra. Windows cần shell cho npm.cmd. */
function runCommand(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, shell: process.platform === "win32", windowsHide: true });
    let out = "";
    const keep = (d: Buffer) => {
      out = (out + d.toString()).slice(-2000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`Lệnh "${cmd} ${args[0]}" lỗi (mã ${code}): ${out.trim().split("\n").slice(-3).join(" ")}`)),
    );
  });
}
