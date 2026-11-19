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
- Chăm sóc (`pages/CarePage.tsx`, `care/CareSection.tsx`, `care.css`): mục "Chăm sóc" cuối cột thông tin Hộp thư (khối lịch nền `--primary-light`, nhãn trên nội dung dưới vì cột hẹp, 2 nút lịch một hàng + "Phân tích lại" hàng riêng), trang Chăm sóc dùng dòng `ib-row` của Hộp thư + ô lọc `ib-seg` (điện thoại 2×2), thẻ nháp tin chăm sóc nền `--success-bg`, thẻ cài đặt ở trang Tính cách
- Khách chờ lâu, gợi ý nhãn (`pages/InboxPage.tsx`, cuối `shell.css`): huy hiệu "Khách chờ" xám như các huy hiệu chờ khác; thẻ `task-card wait-card` trên ô nhắn nền `--warning-bg` (nhờ trợ lý soạn, gắn nhãn gợi ý, không cần trả lời); khối `sug-box` nền `--primary-light` dưới nhãn trợ lý ở cột thông tin
- Gợi ý hỏi đáp (`pages/ProfilesPage.tsx` tầng 2, cuối `styles.css`): khối `learn-box` nền `--primary-light` trên danh sách hỏi đáp, mỗi gợi ý sửa được trước khi thêm; nút "Tìm gợi ý" xuống dòng khi cột hẹp
- Khách trong CRM (`crm/CrmSection.tsx`, cuối `care.css`): mục ở cột thông tin Hộp thư trên mục Chăm sóc, mỗi bản ghi một khối nền `--background` (loại + huy hiệu trạng thái, tên · ngày, danh sách nhãn trên nội dung dưới, link Mở trong Pancake), ô nhập số khi chưa có
- MKT · Kết nối, thẻ Pancake: khối `mkt-match` nền `--background` dưới tên thẻ, một dòng tiến độ + thanh `--primary` 6px + dòng phụ (hôm nay đã tìm, tạm dừng)
- Admin qua Zalo, Báo cáo định kỳ (`admin/AdminZalo.tsx`, cuối `styles.css`): hai card ở trang Tài khoản Zalo dưới thẻ Báo về Zalo; danh sách dòng nền `--background`, chọn admin bằng ô tìm trong Hộp thư, form báo cáo có lịch (select + input time), hai nhóm checkbox lưới tự giãn (người nhận, chỉ số)
- Báo về Zalo của bạn (`pages/AccountsPage.tsx`): card có công tắc `.switch` bên phải, nút Gửi thử, xem trước tóm tắt trong `details`
- Cập nhật (`web/src/update/UpdateDialog.tsx`): thanh báo dưới header (nền `--primary-light`; xong thì nền thành công, lỗi thì nền lỗi), hộp cập nhật dùng `.modal` sẵn có với ghi chú thay đổi và các bước, số bản ở chân sidebar
- Nhóm Zalo (`pages/GroupsPage.tsx`, `groups.css`): phương án A — bảng nhóm đang theo dõi + hộp Quét nhóm; trang nhóm có đường dẫn, nút Đối chiếu ngay / Xuất CSV, 3 tab gạch chân Thống kê (chọn kỳ ngày/tuần/tháng, 4 thẻ số, biểu đồ cột vào/rời vẽ bằng CSS, 3 bảng nhỏ) / Thành viên (dòng thời gian vào, rời) / Chào mừng (công tắc, mẫu tin có ô chèn biến, xem thử, giới hạn, giờ yên lặng, nhật ký gửi). Mở thẳng bằng `?trang=groups&nhom=<mã>&tab=tv|cm`
- Menu (`App.tsx`, từ bản MKT): ba nhóm có tiêu đề ZALO (ô chuyển tài khoản Zalo nằm đầu nhóm, rồi Cần xử lý, Hộp thư, Lịch gửi, Nhóm Zalo, Tính cách, Tài khoản Zalo) / MKT (Tổng quan, Kênh, Kết nối) / CÀI ĐẶT (Mô hình AI). Nút "Trợ lý đang chạy" chỉ ở trang Zalo; trang MKT có nút Làm mới ở header
- MKT · Tổng quan (`pages/mkt/OverviewPage.tsx`, `mkt.css`): phương án A ghép thẻ kênh của B — chọn kỳ (Hôm qua / 7 ngày / 30 ngày / Tháng này, so kỳ trước), dải lỗi kết nối, 6 thẻ số (lượt xem, bình luận, bài, theo dõi mới, chi tiêu QC, lead), lưới thẻ từng kênh (3 số + biểu đồ cột nhỏ, Chi tiết mở panel phải 560px có bảng từng ngày và top bài), khối Lead theo nguồn
- MKT · Kênh (`pages/mkt/ChannelsPage.tsx`): tab gạch chân từng kênh, bảng từng ngày mới nhất trước (Xuất CSV) + top bài 380px sắp theo lượt xem / bình luận
- MKT · Kết nối (`pages/mkt/ConnectionsPage.tsx`): thẻ từng nền tảng (trạng thái, lấy số lúc, số tới ngày, lỗi), hộp nối Facebook hai cách (app Meta riêng / dán token), hộp chọn trang, khối Google Sheet, nhật ký lấy số. Kênh chưa làm hiện "Sắp có"
- Lịch gửi, Tính cách, Mô hình AI: chưa có wireframe riêng, mới đặt vào khung mới và đổi kiểu nút, ô nhập, card
