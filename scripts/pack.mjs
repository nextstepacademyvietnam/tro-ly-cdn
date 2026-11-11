/**
 * Đóng gói bản phát hành vào thư mục release/:
 *   tro-ly-cdn-v<số bản>.tar.gz  (dist + package.json + lock + launcher — khách không phải build)
 *   SHA256SUMS
 *   install.sh, install.ps1, Cai-dat-Tro-ly-CDN.cmd  (bộ cài, tải qua .../releases/latest/download/…)
 * Chạy sau `npm run build`:  node scripts/pack.mjs [--version 1.2.3]
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const vi = process.argv.indexOf("--version");
const version = vi > 0 ? process.argv[vi + 1] : pkg.version;
const out = path.join(root, "release");
const stage = path.join(out, "stage");

if (!fs.existsSync(path.join(root, "dist", "server", "index.js"))) {
  console.error("Chưa build: chạy npm run build trước.");
  process.exit(1);
}
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
for (const f of ["dist", "package.json", "package-lock.json", "launcher.mjs", "LICENSE", "NOTICE", "README.md", "CHANGELOG.md"]) {
  fs.cpSync(path.join(root, f), path.join(stage, f), { recursive: true });
}
if (version !== pkg.version) {
  // Dùng khi thử nghiệm: đóng gói cùng mã với số bản khác.
  const p = JSON.parse(fs.readFileSync(path.join(stage, "package.json"), "utf8"));
  p.version = version;
  fs.writeFileSync(path.join(stage, "package.json"), `${JSON.stringify(p, null, 2)}\n`);
}
const name = `tro-ly-cdn-v${version}.tar.gz`;
// Đường dẫn tương đối: tar của Git Bash hiểu "C:" là máy từ xa.
const tar = spawnSync("tar", ["-czf", name, "-C", "stage", "."], { cwd: out, stdio: "inherit" });
if (tar.status !== 0) process.exit(tar.status ?? 1);
fs.rmSync(stage, { recursive: true, force: true });
const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(out, name))).digest("hex");
fs.writeFileSync(path.join(out, "SHA256SUMS"), `${sha}  ${name}\n`);
for (const f of ["install.sh", "install.ps1", "Cai-dat-Tro-ly-CDN.cmd"]) fs.copyFileSync(path.join(root, "install", f), path.join(out, f));
console.log(`Đã đóng gói release/${name}`);
