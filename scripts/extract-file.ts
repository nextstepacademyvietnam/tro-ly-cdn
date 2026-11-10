// Thử rút chữ từ một file như khi tải lên trang Tính cách: npx tsx scripts/extract-file.ts <đường dẫn>
import fs from "node:fs";
import path from "node:path";
import { extractText } from "../src/core/documents.js";

for (const file of process.argv.slice(2)) {
  try {
    const text = await extractText(path.basename(file), fs.readFileSync(file));
    console.log(`--- ${path.basename(file)}: ${text.length} ký tự\n${text.slice(0, 220).replace(/\n/g, " ⏎ ")}`);
  } catch (err) {
    console.log(`--- ${path.basename(file)}: LỖI ${(err as Error).message}`);
  }
}
