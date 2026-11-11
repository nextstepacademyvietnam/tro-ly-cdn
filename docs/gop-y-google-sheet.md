# Nhận báo lỗi, góp ý vào Google Sheet

Khách bấm biểu tượng **con bọ** ở góc dưới bên trái app, viết góp ý rồi bấm Gửi. Mỗi lần gửi thành **một dòng trong Google Sheet của bạn**. Ảnh chụp màn hình được lưu vào Drive, ô Ảnh là đường dẫn tới ảnh. Dựng một lần, khoảng 5 phút.

## Dựng nơi nhận

1. Tạo một Google Sheet mới (VD: *Trợ lý CDN – Báo lỗi*), bằng tài khoản Google bạn muốn nhận.
2. Trong Sheet: **Tiện ích mở rộng → Apps Script**.
3. Xoá hết chữ có sẵn, dán toàn bộ nội dung file [`gop-y-google-sheet/Code.gs`](gop-y-google-sheet/Code.gs).
   Muốn có email mỗi khi có báo lỗi mới: điền email vào dòng `NOTIFY_EMAIL = ""`.
4. Bấm **Lưu** (biểu tượng đĩa mềm).
5. Bấm **Triển khai → Tác vụ triển khai mới**:
   - Biểu tượng bánh răng → chọn **Ứng dụng web**.
   - *Thực thi dưới dạng*: **Tôi** (tài khoản của bạn).
   - *Người có quyền truy cập*: **Bất kỳ ai**.
   - Bấm **Triển khai**, rồi **Cho phép truy cập** (chọn tài khoản → *Nâng cao* → *Đi tới… (không an toàn)* → *Cho phép*; đây là script của chính bạn).
6. Chép **URL ứng dụng web** (dạng `https://script.google.com/macros/s/…/exec`). Mở thử URL đó trên trình duyệt: thấy `"ok":true` là được.
7. Dán URL vào `package.json` của repo, trường `"feedbackUrl"`:
   ```json
   "feedbackUrl": "https://script.google.com/macros/s/…/exec",
   ```
   Commit rồi phát hành bản mới (`npm run release -- patch`). Từ bản đó, báo lỗi của mọi khách đi về Sheet này.

Thử trên máy mình mà chưa muốn phát hành: bật app với biến `CDN_FEEDBACK_URL=<URL ở bước 6>`.

## Sheet có gì

| Cột | Nội dung |
| --- | --- |
| Thời gian, Loại | Lúc gửi; *Báo lỗi* hay *Góp ý* |
| Nội dung | Khách viết |
| Liên hệ | Số điện thoại / Zalo nếu khách để lại |
| Bản app, Cách cài, Máy, Trình duyệt, Trang | Chỉ có khi khách để tích *Kèm thông tin máy* |
| Ảnh | Đường dẫn ảnh trong Drive, chỉ có khi khách để tích *Kèm ảnh chụp* |
| Trạng thái | Ghi sẵn *Mới*; bạn tự đổi thành *Đang sửa*, *Xong*… |

## Lưu ý

- Ảnh chụp có thể có tên và tin nhắn khách hàng của người gửi. Chỉ chia sẻ Sheet và thư mục ảnh cho người cần xem.
- Sửa `Code.gs` thì phải **Triển khai → Quản lý tác vụ triển khai → sửa → Phiên bản mới**; URL giữ nguyên.
- URL web app nằm công khai trong repo, nên ai cũng gửi vào được. Script đã chặn chữ bị hiểu thành công thức; nếu bị phá, tạo tác vụ triển khai mới (URL mới) rồi phát hành bản mới.
