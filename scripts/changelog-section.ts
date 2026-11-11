/** In mục của một bản trong CHANGELOG.md (dùng làm mô tả GitHub Release): tsx scripts/changelog-section.ts 0.2.0 */
import fs from "node:fs";
import { changelogSection } from "../src/server/updates.js";

const version = (process.argv[2] ?? "").replace(/^v/, "");
const section = changelogSection(fs.readFileSync("CHANGELOG.md", "utf8"), version);
if (!section) {
  console.error(`CHANGELOG.md không có mục cho bản ${version}`);
  process.exit(1);
}
process.stdout.write(`${section}\n`);
