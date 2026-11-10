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

Dữ liệu nằm trong `data/`: `tro-ly.sqlite` và `secret.key` (khoá mã hoá API key). Sao lưu cả hai; mất `secret.key` thì phải nhập lại các khoá.

## Phát triển

```bash
npm run dev       # server tự nạp lại khi sửa code (cổng 3000)
npm run dev:web   # giao diện có hot reload (cổng 5173, gọi API sang 3000)
npm test
npm run typecheck
npx tsx scripts/check-engines.ts   # thử kết nối gói Claude và ChatGPT trên máy này
```

## Lộ trình

1. ✅ Khung, 4 engine AI, trang quản trị, chat thử
2. ✅ Kết nối Zalo cá nhân bằng mã QR, hộp thư (đã thử trên tài khoản thật 10/11/2026)
3. ✅ Trả lời khách: AI trả lời theo tính cách gắn nhãn, nháp chờ duyệt, chuyển người thật
4. Thư ký cá nhân: tóm tắt ngày, nhắc việc
5. Chăm sóc chủ động: sinh nhật, follow-up (đã có: lịch gửi tin kèm ảnh)
6. Quản lý nhóm Zalo
7. Bộ cài một lệnh cho VPS và Windows, Docker

## Giấy phép

MIT. Phần kết nối Zalo sẽ dựa trên [zalo-hermes](https://github.com/congthuanmmm/zalo-hermes) (MIT, Cong Thuan MMM) và [zca-js](https://github.com/RFS-ADRENO/zca-js) (MIT).
