/**
 * Giả GitHub Releases để thử bộ cài và cập nhật mà không cần phát hành thật.
 *   node scripts/fake-release-server.mjs <thư mục release> [cổng=3021]
 * /latest trả JSON giống api.github.com/.../releases/latest cho bản .tar.gz mới nhất trong thư mục;
 * /dl/<tên file> trả file. Ghi chú thay đổi lấy từ CHANGELOG.md (nếu có mục của bản đó).
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(process.argv[2] ?? "release");
const port = Number(process.argv[3] ?? 3021);
const base = `http://127.0.0.1:${port}`;
const ver = (n) => n.match(/v(\d+\.\d+\.\d+)\.tar\.gz$/)?.[1];
const cmp = (a, b) => a.split(".").map(Number).reduce((r, x, i) => r || x - b.split(".").map(Number)[i], 0);

http
  .createServer((req, res) => {
    // Thư mục release có thể đang bị đóng gói lại: lỗi đọc thì trả 503, không làm chết server.
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      return res.writeHead(503).end();
    }
    if (req.url === "/latest") {
      const tars = files.filter(ver).sort((a, b) => cmp(ver(a), ver(b)));
      const tar = tars.at(-1);
      if (!tar) return res.writeHead(404).end();
      res.setHeader("content-type", "application/json");
      return res.end(
        JSON.stringify({
          tag_name: `v${ver(tar)}`,
          body: "### Mới\n- Bản thử nghiệm.",
          html_url: base,
          published_at: new Date().toISOString(),
          draft: false,
          prerelease: false,
          assets: [tar, "SHA256SUMS"].map((name) => ({ name, browser_download_url: `${base}/dl/${name}` })),
        }),
      );
    }
    const name = decodeURIComponent((req.url ?? "").replace(/^\/dl\//, ""));
    if (req.url?.startsWith("/dl/") && files.includes(name)) return res.end(fs.readFileSync(path.join(dir, name)));
    res.writeHead(404).end();
  })
  .listen(port, "127.0.0.1", () => console.log(`Giả GitHub Releases: ${base}/latest (thư mục ${dir})`));
