# Đóng góp cho Trợ lý CDN

Cảm ơn bạn quan tâm! Vài quy ước để mọi người làm cùng nhau dễ:

## Chạy trên máy

```bash
npm install
npm run dev       # server (cổng 3000)
npm run dev:web   # giao diện (cổng 5173)
```

Trước khi mở pull request, chạy đủ ba lệnh (CI chạy lại trên Ubuntu và Windows, Node 22 và 24):

```bash
npm run typecheck
npm test
npm run build
```

## Quy ước

- **Giao diện và thông báo bằng tiếng Việt**, viết cho người không rành kỹ thuật.
- **Giao diện** theo `DESIGN.md`: token màu ở `web/src/tokens.css`, không rải mã màu trong component.
- **Đổi cấu trúc dữ liệu** thì thêm migration mới vào cuối mảng `MIGRATIONS` trong `src/server/db.ts`, không sửa migration cũ. App cập nhật chạy migration tự động và không quay ngược được, nên migration phải giữ dữ liệu cũ.
- **Ghi thay đổi** khách thấy được vào `CHANGELOG.md`, mục `## [Chưa phát hành]`.
- **Commit** ngắn gọn, nói việc gì đã đổi và vì sao.

## Phát hành

Chỉ người giữ repo phát hành. Các bước ở [docs/phat-hanh.md](docs/phat-hanh.md).
