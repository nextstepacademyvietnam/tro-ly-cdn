# Trợ lý CDN

Trợ lý AI mã nguồn mở, chạy 24/7 trên máy của bạn hoặc trên VPS. Bạn chọn "bộ não" (gói Claude, gói ChatGPT hoặc API key), dặn trợ lý tính cách và cách làm việc, rồi để nó làm thay bạn.

Tính năng đầu tiên đang làm: **trợ lý Zalo cá nhân** — trả lời tin nhắn khách, làm thư ký, chăm sóc khách chủ động, quản lý nhóm.

> Trạng thái: **đang phát triển**. Đã có: trang quản trị tiếng Việt (sáng/tối), 4 loại mô hình AI, nhiều tài khoản Zalo đăng nhập bằng QR, hộp thư có lọc và thao tác hàng loạt, nhiều tính cách gắn theo nhãn Zalo thật, hướng dẫn AI chia 4 tầng theo mức độ thay đổi (luật an toàn · danh tính · kiến thức · thông tin thời điểm có hạn), chat thử, nhờ AI tối ưu, sao chép giữa tài khoản, lịch gửi tin kèm ảnh, AI trả lời khách theo tính cách (soạn nháp chờ duyệt hoặc tự gửi, tự chuyển người thật, tạm dừng toàn bộ). Luật quyền: docs/quyen-tro-ly.md.

## Mô hình AI hỗ trợ

| Lựa chọn | Cần gì | Chi phí |
|---|---|---|
| Gói Claude (Pro/Max) | Cài [Claude Code](https://claude.com/claude-code) trên máy chạy app, gõ `claude` để đăng nhập | Nằm trong gói |
| Gói ChatGPT (Plus/Pro) | Cài Codex CLI (`npm i -g @openai/codex`), chạy `codex login` (VPS: `codex login --device-auth`) | Nằm trong gói |
| API key OpenAI / Gemini / OpenRouter / DeepSeek / Ollama | Dán key vào trang Mô hình AI | Theo lượng dùng |
| API key Anthropic | Key từ platform.claude.com | Theo lượng dùng |

Trợ lý CDN **không đọc, không lưu token đăng nhập** của Claude hay ChatGPT: nó chỉ gọi đúng chương trình `claude` / `codex` mà bạn đã tự cài và tự đăng nhập. CLI chạy trong một thư mục rỗng riêng, tắt hết công cụ, nên chỉ biết những gì app đưa cho. Khi chạy cho doanh nghiệp, nên dùng API key theo điều khoản của nhà cung cấp.

## Cài đặt

Bộ cài tự tải Node.js riêng cho app (không cần quyền quản trị, không đụng phần mềm khác), cài bản mới nhất, cài Codex để nối gói ChatGPT, cho app tự chạy khi mở máy, rồi mở app trên trình duyệt. Chạy lại bộ cài = sửa chữa hoặc lên bản mới nhất, dữ liệu giữ nguyên.

**Windows 10/11**: tải [Cai-dat-Tro-ly-CDN.cmd](https://github.com/nextstepacademyvietnam/tro-ly-cdn/releases/latest/download/Cai-dat-Tro-ly-CDN.cmd) rồi bấm đúp. Windows hiện "Windows đã bảo vệ máy tính của bạn" thì bấm **Thông tin thêm** → **Vẫn chạy**. App cài vào `%LOCALAPPDATA%TroLyCDN`, có biểu tượng "Trợ lý CDN" trên Màn hình nền.

**macOS** (và Linux/VPS): mở Terminal, dán:

```bash
curl -fsSL https://github.com/nextstepacademyvietnam/tro-ly-cdn/releases/latest/download/install.sh | bash
```

macOS cài vào `~/Library/Application Support/TroLyCDN` (Linux: `~/.tro-ly-cdn`), chạy nền bằng LaunchAgent (Linux: systemd), có ứng dụng "Trợ lý CDN" để bấm mở.

Gỡ cài đặt: chạy `go-cai-dat.cmd` (Windows) hoặc `go-cai-dat.sh` (macOS, Linux) trong thư mục cài. Mặc định giữ lại thư mục `data`.

Hướng dẫn từng bước cho người không rành kỹ thuật: [docs/Huong-dan-su-dung-Tro-ly-CDN.docx](docs/Huong-dan-su-dung-Tro-ly-CDN.docx).

## Chạy thử (bản dành cho người phát triển)

Cần Node.js 22.13 trở lên.

```bash
npm install
npm run build
npm start
```

Mở http://localhost:3000, tạo tài khoản quản trị ở lần đầu, vào **Mô hình AI** chọn bộ não, bấm **Kiểm tra kết nối**, rồi **Lưu** và sang **Chat thử**.

Biến môi trường:

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `3000` | Cổng web |
| `HOST` | `127.0.0.1` | Chỉ nghe trên máy này. Trên VPS đặt `0.0.0.0` **và** đặt sau HTTPS (Caddy/Nginx) |
| `CDN_DATA_DIR` | `./data` | Nơi lưu cơ sở dữ liệu và khoá mã hoá |
| `SECURE_COOKIES` | — | Đặt `1` khi chạy sau HTTPS |
| `CDN_UPDATE_CHECK` | — | Đặt `0` để tắt kiểm tra bản mới |

Dữ liệu nằm trong `data/`: `tro-ly.sqlite` và `secret.key` (khoá mã hoá API key). Sao lưu cả hai; mất `secret.key` thì phải nhập lại các khoá.

## Cập nhật

App tự hỏi GitHub mỗi 6 giờ xem có bản phát hành mới không. Có thì hiện thanh báo trên web và một thông báo ở chuông, kèm danh sách thay đổi.

- **Cài bằng bộ cài** (chạy qua `launcher.mjs`, có thư mục `versions/`): bấm **Cập nhật ngay**. App tải gói cài, kiểm tra mã SHA256, cài vào thư mục riêng, sao lưu dữ liệu vào `data/backups/` rồi khởi động lại. Bản mới không chạy được trong 90 giây thì app tự quay về bản cũ và chép lại dữ liệu.
- **Chạy từ mã nguồn** (git clone): app chỉ báo, bạn tự chạy `git pull`, `npm install`, `npm run build` rồi bật lại.

Danh sách thay đổi của từng bản nằm ở [CHANGELOG.md](CHANGELOG.md).

### App gửi gì ra ngoài

Ngoài Zalo và mô hình AI bạn chọn, app chỉ gọi `api.github.com` để hỏi số bản mới nhất, và tải gói cài khi bạn bấm cập nhật. Không gửi dữ liệu, tin nhắn hay thông tin máy của bạn đi đâu. Bản fork tự hỏi repo ghi trong `repository` của `package.json`.

## Phát triển

```bash
npm run dev       # server tự nạp lại khi sửa code (cổng 3000)
npm run dev:web   # giao diện có hot reload (cổng 5173, gọi API sang 3000)
npm test
npm run typecheck
npx tsx scripts/check-engines.ts   # thử kết nối gói Claude và ChatGPT trên máy này
```

Phát hành bản mới: xem [docs/phat-hanh.md](docs/phat-hanh.md). Đóng góp: xem [CONTRIBUTING.md](CONTRIBUTING.md).

## Lộ trình

1. ✅ Khung, 4 engine AI, trang quản trị, chat thử
2. ✅ Kết nối Zalo cá nhân bằng mã QR, hộp thư (đã thử trên tài khoản thật 10/11/2026)
3. ✅ Trả lời khách: AI trả lời theo tính cách gắn nhãn, nháp chờ duyệt, chuyển người thật
4. Thư ký cá nhân: tóm tắt ngày, nhắc việc
5. Chăm sóc chủ động: sinh nhật, follow-up (đã có: lịch gửi tin kèm ảnh)
6. Quản lý nhóm Zalo
7. ✅ Bộ cài cho Windows, macOS, Linux/VPS; cập nhật một chạm (còn: Docker)

## Giấy phép

MIT. Phần kết nối Zalo sẽ dựa trên [zalo-hermes](https://github.com/congthuanmmm/zalo-hermes) (MIT, Cong Thuan MMM) và [zca-js](https://github.com/RFS-ADRENO/zca-js) (MIT).
