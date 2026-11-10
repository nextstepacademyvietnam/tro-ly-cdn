import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Thư mục gốc của repo (chứa package.json), tính từ src/server hoặc dist/server. */
export const ROOT_DIR = path.resolve(here, "..", "..");

export const DATA_DIR = path.resolve(process.env.CDN_DATA_DIR ?? path.join(ROOT_DIR, "data"));
export const WEB_DIR = path.join(ROOT_DIR, "dist", "web");
export const PORT = Number(process.env.PORT ?? 3000);
/** Mặc định chỉ nghe trên máy này. Trên VPS đặt HOST=0.0.0.0 và đặt sau HTTPS. */
export const HOST = process.env.HOST ?? "127.0.0.1";

export function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
