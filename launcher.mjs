#!/usr/bin/env node
/**
 * Trình khởi động Trợ lý CDN — bọc ngoài app, lo việc đổi bản khi cập nhật.
 *
 * Bố cục khi cài bằng bộ cài:
 *   launcher.mjs          ← file này (chạy: node launcher.mjs)
 *   current.json          ← {"version":"0.2.0","previous":"0.1.0"}
 *   versions/<số bản>/    ← mỗi bản một thư mục, có node_modules riêng
 *   data/                 ← dữ liệu (đặt chỗ khác bằng CDN_DATA_DIR)
 * Không có current.json (chạy từ mã nguồn git) thì chạy thẳng dist/server/index.js, không tự cập nhật.
 *
 * App thoát mã 75 = đã chuẩn bị bản mới (update-pending.json). Launcher đổi sang bản mới, chờ
 * /api/status trả lời đúng số bản trong 90 giây; không được thì quay về bản cũ và chép lại DB đã sao lưu.
 * Không dùng thư viện ngoài: file này phải chạy được với mọi bản.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CURRENT = path.join(ROOT, "current.json");
const PENDING = path.join(ROOT, "update-pending.json");
const DATA = path.resolve(process.env.CDN_DATA_DIR ?? path.join(ROOT, "data"));
const PORT = Number(process.env.PORT ?? 3000);
const RESTART_CODE = 75;
const HEALTH_TIMEOUT_MS = Number(process.env.CDN_HEALTH_TIMEOUT_MS ?? 90_000);

const log = (msg) => console.log(`[launcher] ${msg}`);
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
};

/** Bản đang dùng và file chạy của nó. */
function target() {
  const cur = readJson(CURRENT);
  if (cur?.version) {
    const dir = path.join(ROOT, "versions", cur.version);
    return { managed: true, version: cur.version, dir, entry: path.join(dir, "dist", "server", "index.js") };
  }
  return { managed: false, version: null, dir: ROOT, entry: path.join(ROOT, "dist", "server", "index.js") };
}

let child = null;
let stopping = false;

function start(t) {
  if (!fs.existsSync(t.entry)) {
    console.error(`[launcher] Không thấy ${t.entry}. Chạy "npm run build" (bản mã nguồn) hoặc cài lại.`);
    process.exit(1);
  }
  const env = { ...process.env, CDN_DATA_DIR: DATA };
  if (t.managed) Object.assign(env, { CDN_INSTALL_DIR: ROOT, CDN_LAUNCHER: "1" });
  child = spawn(process.execPath, [t.entry], { cwd: t.dir, env, stdio: "inherit" });
  return child;
}

const exited = (c) => new Promise((resolve) => (c.exitCode !== null || c.signalCode ? resolve(c.exitCode) : c.once("exit", (code) => resolve(code))));

/** Chờ app trả lời /api/status với đúng số bản. */
async function healthy(version, c) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (c.exitCode !== null || c.signalCode) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/status`, { signal: AbortSignal.timeout(3000) });
      if (res.ok && (await res.json()).version === version) return true;
    } catch {
      /* chưa lên */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** Giữ bản đang chạy và bản trước đó, xoá các bản cũ hơn. */
function prune(keep) {
  const dir = path.join(ROOT, "versions");
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!keep.includes(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

function restoreDb(backup) {
  if (!backup || !fs.existsSync(backup)) return false;
  const db = path.join(DATA, "tro-ly.sqlite");
  for (const f of [`${db}-wal`, `${db}-shm`]) fs.rmSync(f, { force: true });
  fs.copyFileSync(backup, db);
  return true;
}

async function switchVersion() {
  const pending = readJson(PENDING);
  if (!pending?.to || !pending?.from) return;
  log(`Đổi bản ${pending.from} → ${pending.to}`);
  writeJson(CURRENT, { version: pending.to, previous: pending.from });
  const c = start(target());
  watch(c, true);
  if (await healthy(pending.to, c)) {
    c.removeAllListeners("exit");
    watch(c, false);
    writeJson(path.join(DATA, "update-state.json"), { result: "ok", from: pending.from, to: pending.to, at: Date.now() });
    fs.rmSync(PENDING, { force: true });
    prune([pending.to, pending.from]);
    // Bản mới có thể mang launcher mới: chép đè, lần bật sau mới dùng.
    const next = path.join(ROOT, "versions", pending.to, "launcher.mjs");
    const self = fileURLToPath(import.meta.url);
    if (fs.existsSync(next) && fs.readFileSync(next, "utf8") !== fs.readFileSync(self, "utf8")) fs.copyFileSync(next, self);
    log(`Đã lên bản ${pending.to}`);
    return;
  }
  log(`Bản ${pending.to} không chạy được — quay về ${pending.from}`);
  c.removeAllListeners("exit");
  const crashed = c.exitCode !== null || Boolean(c.signalCode);
  if (!crashed) c.kill();
  await exited(c);
  const restored = restoreDb(pending.backup);
  writeJson(CURRENT, { version: pending.from, previous: null });
  writeJson(path.join(DATA, "update-state.json"), {
    result: "rolled_back",
    from: pending.from,
    to: pending.to,
    at: Date.now(),
    error: `${crashed ? `Bản ${pending.to} bị dừng ngay khi khởi động` : `Bản ${pending.to} không trả lời sau ${Math.round(HEALTH_TIMEOUT_MS / 1000)} giây`}${restored ? "; dữ liệu đã được chép lại từ bản sao lưu" : ""}.`,
  });
  fs.rmSync(PENDING, { force: true });
  // Bản hỏng không giữ lại: lần sau cập nhật tải lại từ đầu.
  fs.rmSync(path.join(ROOT, "versions", pending.to), { recursive: true, force: true });
  watch(start(target()), false);
}

const crashes = [];
/** Theo dõi app: mã 75 thì đổi bản, chết bất thường thì bật lại (tối đa 3 lần / 5 phút). */
function watch(c, duringSwitch) {
  c.once("exit", (code, signal) => {
    if (stopping) process.exit(code ?? 0);
    if (duringSwitch) return; // switchVersion tự xử lý
    if (code === RESTART_CODE) return void switchVersion();
    if (code === 0) process.exit(0);
    const now = Date.now();
    crashes.push(now);
    while (crashes.length && now - crashes[0] > 300_000) crashes.shift();
    if (crashes.length > 3) {
      console.error("[launcher] App dừng bất thường nhiều lần liên tiếp — xem lỗi ở trên.");
      process.exit(1);
    }
    log(`App dừng (mã ${code ?? signal}), bật lại sau 2 giây`);
    setTimeout(() => watch(start(target()), false), 2000);
  });
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopping = true;
    if (child && child.exitCode === null) child.kill(sig);
    else process.exit(0);
  });
}

// Quên mật khẩu: node launcher.mjs --dat-lai-mat-khau [mật khẩu mới] — chạy lệnh đặt lại của bản đang dùng rồi thoát.
const resetAt = process.argv.indexOf("--dat-lai-mat-khau");
if (resetAt > 0) {
  const t = target();
  const script = path.join(t.dir, "dist", "server", "reset-password.js");
  if (!fs.existsSync(script)) {
    console.error("[launcher] Bản này chưa có lệnh đặt lại mật khẩu. Cập nhật app rồi thử lại.");
    process.exit(1);
  }
  const r = spawnSync(process.execPath, [script, ...process.argv.slice(resetAt + 1)], {
    cwd: t.dir,
    env: { ...process.env, CDN_DATA_DIR: DATA },
    stdio: "inherit",
  });
  process.exit(r.status ?? 1);
}

// Lần bật trước bị tắt ngang lúc đang đổi bản: làm nốt.
if (readJson(PENDING) && target().managed) void switchVersion();
else watch(start(target()), false);
