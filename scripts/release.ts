/**
 * Phát hành bản mới: npm run release -- patch | minor | major | 1.2.3  [--dry-run] [--no-push]
 *
 * 1. Kiểm tra: đang ở nhánh main, không có thay đổi chưa commit, mục "Chưa phát hành" trong CHANGELOG có nội dung.
 * 2. Chạy typecheck, test, build.
 * 3. Nâng số bản trong package.json + package-lock.json, đổi "Chưa phát hành" thành "[x.y.z] - ngày".
 * 4. Commit, gắn tag vX.Y.Z, đẩy lên GitHub. GitHub Actions (release.yml) đóng gói và tạo Release.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import { compareVersions } from "../src/server/updates.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const noPush = args.includes("--no-push");
const bump = args.find((a) => !a.startsWith("--")) ?? "";
const UNRELEASED = "## [Chưa phát hành]";

const sh = (cmd: string) => execSync(cmd, { stdio: "inherit" });
const out = (cmd: string) => execSync(cmd, { encoding: "utf8" }).trim();
const fail = (msg: string): never => {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
};

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { version: string };
const [ma, mi, pa] = pkg.version.split(".").map(Number) as [number, number, number];
const next =
  bump === "patch" ? `${ma}.${mi}.${pa + 1}` : bump === "minor" ? `${ma}.${mi + 1}.0` : bump === "major" ? `${ma + 1}.0.0` : /^\d+\.\d+\.\d+$/.test(bump) ? bump : "";
if (!next) fail("Cách dùng: npm run release -- patch | minor | major | 1.2.3  [--dry-run]");
if (compareVersions(next, pkg.version) <= 0) fail(`Bản ${next} không mới hơn bản hiện tại ${pkg.version}`);

if (out("git rev-parse --abbrev-ref HEAD") !== "main") fail("Chỉ phát hành từ nhánh main.");
if (out("git status --porcelain") && !dryRun) fail("Còn thay đổi chưa commit. Commit hoặc cất đi rồi chạy lại.");
if (out(`git tag --list v${next}`)) fail(`Tag v${next} đã có.`);

const changelog = fs.readFileSync("CHANGELOG.md", "utf8").replace(/\r\n/g, "\n");
const start = changelog.indexOf(UNRELEASED);
if (start < 0) fail(`CHANGELOG.md thiếu mục "${UNRELEASED}".`);
const after = changelog.slice(start + UNRELEASED.length);
const nextHeading = after.search(/\n## /);
const body = (nextHeading < 0 ? after : after.slice(0, nextHeading)).trim();
if (!body) fail(`Mục "${UNRELEASED}" trong CHANGELOG.md đang trống — ghi người dùng được gì ở bản này trước đã.`);

console.log(`\nPhát hành ${pkg.version} → ${next}${dryRun ? " (chạy thử, không ghi gì)" : ""}\n\n${body}\n`);
sh("npm run typecheck");
sh("npm test");
sh("npm run build");
if (dryRun) {
  console.log("\n✔ Chạy thử xong, mọi bước kiểm tra đều qua.");
  process.exit(0);
}

const today = new Date().toISOString().slice(0, 10);
fs.writeFileSync("CHANGELOG.md", changelog.replace(UNRELEASED, `${UNRELEASED}\n\n## [${next}] - ${today}`));
for (const file of ["package.json", "package-lock.json"]) {
  const json = JSON.parse(fs.readFileSync(file, "utf8")) as { version: string; packages?: Record<string, { version?: string }> };
  json.version = next;
  if (json.packages?.[""]) json.packages[""].version = next;
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}
sh("git add CHANGELOG.md package.json package-lock.json");
sh(`git commit -m "Phát hành v${next}"`);
sh(`git tag -a v${next} -m "v${next}"`);
if (noPush) {
  console.log(`\n✔ Đã tạo commit và tag v${next}. Đẩy lên bằng: git push origin main v${next}`);
} else {
  sh(`git push origin main v${next}`);
  console.log(`\n✔ Đã đẩy v${next}. GitHub Actions đang đóng gói — xem tab Actions, xong sẽ có Release.`);
}
