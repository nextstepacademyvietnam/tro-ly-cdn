# Mục MKT (tắt sẵn)

Mục MKT chỉ dành cho máy của NSG. Nó **không** hiện trong bản phát hành cho khách, vì khách chỉ dùng phần Zalo.
Code nằm chung với phần còn lại, chỉ bật khi có công tắc. Bật bằng một trong hai cách:

- Đặt biến môi trường `CDN_MKT=1` trước khi chạy app.
- Hoặc tạo một file rỗng tên `bat-mkt` trong thư mục dữ liệu (cạnh `tro-ly.sqlite`). Cách này còn nguyên qua các lần cập nhật.

Tắt: bỏ biến hoặc xoá file, rồi khởi động lại app. Số liệu và kết nối MKT vẫn nằm trong cơ sở dữ liệu; bật lại là thấy.

Khi tắt, server không đăng ký route `/api/mkt/*`, không chạy lịch lấy số, và menu không có nhóm MKT.

Vì khách không thấy mục này, **đừng ghi thay đổi của MKT vào `CHANGELOG.md`**: nhật ký đó hiện trong app của khách khi có bản mới. Ghi ở đây.

## Đã có

- Tổng quan số marketing theo kỳ (hôm qua, 7 ngày, 30 ngày, tháng này) so với kỳ trước, thẻ từng kênh. Màn Kênh có bảng từng ngày, top bài và xuất CSV.
- **Fanpage Facebook**: đăng nhập bằng app Meta của chính mình, hoặc dán token có sẵn. Mỗi sáng 06:00 app lấy lượt xem, tương tác, bình luận, bài đăng và người theo dõi. Lần nối đầu lấy lùi 120 ngày.
- **Kênh YouTube**: tải file JSON client của Google Cloud rồi đăng nhập Google của chủ kênh. App lấy lượt xem, bình luận, lượt thích, phút xem, đăng ký mới và video đăng (chỉ video công khai). YouTube trễ khoảng 3 ngày, nên ngày chưa có số để trống.
- **Pancake CRM**: nhập API key và Shop ID.
  - App đếm lead theo nguồn và đếm lead là founder.
  - Tổng lead khử trùng theo số điện thoại trên cả bảng lead và bảng workshop.
  - Luật nguồn lead sửa được trên màn Kết nối.
  - App chỉ lưu số đếm, không lưu tên hay số điện thoại.

## Lưu ý

- Bình luận Facebook chỉ đếm bình luận của khách. App bỏ mọi câu trả lời của trang, kể cả câu trang tự gõ, nên số thấp hơn số bộ script cũ ghi vào Sheet.
- Chưa có: TikTok, quảng cáo Meta, đổ số vào Google Sheet.
