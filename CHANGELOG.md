# Nhật ký thay đổi

Mỗi bản phát hành một mục. Mục của bản mới nhất hiện cho người dùng trong app khi có bản cập nhật,
nên viết bằng lời dễ hiểu, nói người dùng được gì. Đặt các thay đổi đang làm dưới **Chưa phát hành**;
lệnh `npm run release` sẽ đổi tiêu đề đó thành số bản kèm ngày.

Các nhóm dùng trong mỗi mục: `### Mới`, `### Sửa`, `### Lưu ý`. Bản có mục **Lưu ý** (việc người dùng
phải làm, hoặc thay đổi cần biết trước) thì thanh báo cập nhật trong app không cho ẩn.

## [Chưa phát hành]

### Mới
- App tự báo khi có bản mới, xem được danh sách thay đổi ngay trong app.
- Cập nhật bằng một nút bấm: app tự sao lưu dữ liệu, cài bản mới, khởi động lại; bản mới không chạy được thì tự quay về bản cũ.
- Số phiên bản hiện ở chân thanh menu, bấm vào để kiểm tra bản mới.

## [0.1.0] - 2026-11-10

### Mới
- Kết nối nick Zalo cá nhân bằng mã QR, dùng nhiều tài khoản Zalo cùng lúc.
- Hộp thư 3 cột: việc cần xử lý, hội thoại, nhãn trợ lý và lịch gửi của từng khách.
- Tính cách trợ lý gắn với nhãn Zalo thật, hướng dẫn AI chia 4 tầng, AI soạn nháp chờ duyệt hoặc tự gửi.
- Lịch gửi tin cho nhiều người, kèm ảnh, lặp lại theo ngày, tuần, tháng.
- Nối AI bằng gói Claude, gói ChatGPT hoặc API key.
