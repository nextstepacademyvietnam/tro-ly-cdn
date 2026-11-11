# Thiết kế giao diện

Skill evon:ui-ux đọc file này trước khi dựng. Sửa tay được; file trái với code thì code thắng.

## Sản phẩm
- Sản phẩm: Trợ lý CDN, trợ lý AI tự cài chạy trên nick Zalo cá nhân (trả lời khách, thư ký, chăm sóc, quản lý nhóm)
- Người dùng: chủ doanh nghiệp nhỏ, không rành kỹ thuật, mở app giữa giờ làm để duyệt việc trợ lý cần
- Việc chính: xử lý hội thoại cần mình (duyệt nháp, nhận khách trợ lý chuyển sang), gắn nhãn trợ lý, lên lịch gửi
- Nền tảng: web trên máy tính là chính, điện thoại để xem nhanh
- Điểm khác biệt: nhãn trợ lý là nhãn thật trong Zalo, gắn trên điện thoại cũng được

## Giao diện
- Bộ mặt: Soft (P13): sidebar 240px, header 56px, card không viền nổi bằng bóng nhẹ, font Be Vietnam Pro (đóng gói qua `@fontsource`, chạy được khi máy không có mạng)
- Sắc: Neutral (P17): huy hiệu chờ lâu (từ 15 phút, từ 1 giờ) để xám, chưa tô màu
- Màu nhấn: xanh Zalo `#0068ff` (tối `#4d94ff`), token `--primary` ở khối "MÀU DỰ ÁN" cuối `web/src/tokens.css`
- Phong cách: nổi nhẹ (P7), không glass, không gradient
- Nền tối: có, class `dark` trên `<html>`; nút ở chân sidebar đổi theo máy → sáng → tối
- CSS thuần (không Tailwind): token `web/src/tokens.css`, kiểu chung `web/src/styles.css`, khung app và Hộp thư `web/src/shell.css`. Icon: `lucide-react`

## Người dùng dặn
- (chưa có)

## Màn đã dựng
- Khung app (`App.tsx`): phương án A — sidebar có ô chuyển tài khoản Zalo, mục Cần xử lý / Hộp thư / Lịch gửi / Tính cách, nhóm Cài đặt (Tài khoản Zalo, Mô hình AI); header có nút Trợ lý đang chạy (tạm dừng) và chuông thông báo
- Hộp thư (`pages/InboxPage.tsx`): phương án A, 3 cột — danh sách 320px (Cần xử lý / Tất cả, tìm, Lọc), hội thoại có thẻ nháp trên ô nhắn, cột thông tin 300px (nhãn trợ lý, lịch gửi, khách); dưới 1280px cột thông tin trượt từ phải ra qua nút (i)
- Tài khoản Zalo (`pages/AccountsPage.tsx`): kết nối, mã QR, đổi tên, xoá — tách ra từ Hộp thư cũ
- Cập nhật (`web/src/update/UpdateDialog.tsx`): thanh báo dưới header (nền `--primary-light`; xong thì nền thành công, lỗi thì nền lỗi), hộp cập nhật dùng `.modal` sẵn có với ghi chú thay đổi và các bước, số bản ở chân sidebar
- Lịch gửi, Tính cách, Mô hình AI: chưa có wireframe riêng, mới đặt vào khung mới và đổi kiểu nút, ô nhập, card
