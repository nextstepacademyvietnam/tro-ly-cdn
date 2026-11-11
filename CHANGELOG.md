# Nhật ký thay đổi

Mỗi bản phát hành một mục. Mục của bản mới nhất hiện cho người dùng trong app khi có bản cập nhật,
nên viết bằng lời dễ hiểu, nói người dùng được gì. Đặt các thay đổi đang làm dưới **Chưa phát hành**;
lệnh `npm run release` sẽ đổi tiêu đề đó thành số bản kèm ngày.

Các nhóm dùng trong mỗi mục: `### Mới`, `### Sửa`, `### Lưu ý`. Bản có mục **Lưu ý** (việc người dùng
phải làm, hoặc thay đổi cần biết trước) thì thanh báo cập nhật trong app không cho ẩn.

## [Chưa phát hành]

## [0.2.1] - 2026-11-11

### Sửa
- Bộ cài Windows không còn dừng ở bước 4 với lỗi "Unable to save shortcut" trên máy có thư mục tiếng Việt (VD: Màn hình nền OneDrive tên "Máy tính"). Ai đã gặp lỗi này: bấm đúp lại file cài đặt, dữ liệu giữ nguyên.

## [0.2.0] - 2026-11-11

### Mới
- Mục **Nhóm Zalo**: quét các nhóm nick trợ lý đang ở, chọn nhóm để theo dõi ai vào, ai rời (tự rời, bị mời ra, bị chặn), được ai thêm vào.
- Thống kê nhóm theo ngày, tuần, tháng: thành viên hiện tại, vào mới, rời, tăng ròng, cách vào nhóm, ai thêm nhiều người nhất, tỉ lệ ở lại sau 7 và 30 ngày. Xuất danh sách vào/rời ra file CSV mở bằng Excel.
- Luồng chào mừng thành viên mới: chào trong nhóm (gom người vào gần nhau thành một tin, tag tên) và chào riêng từng người (có giới hạn mỗi giờ, mỗi ngày và giờ yên lặng để Zalo không khoá nick).
- Số liệu nhóm tính từ lúc bật theo dõi (Zalo không lưu lịch sử vào, rời trước đó). Người vào, rời lúc app tắt được phát hiện khi đối chiếu lại danh sách, mỗi lần app bật và mỗi 6 giờ.
- Nút **Báo lỗi, góp ý** (biểu tượng con bọ ở góc dưới bên trái): viết góp ý, kèm ảnh chụp màn hình, thông tin máy, số liên hệ nếu muốn, gửi thẳng tới đội làm app.
- **Quên mật khẩu?** ở màn đăng nhập chỉ cách đặt lại ngay trên máy chạy app (Windows có sẵn mục trong menu Start).
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
