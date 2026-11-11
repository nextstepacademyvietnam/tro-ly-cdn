# Ý tưởng: Theo dõi nhóm Zalo và luồng chào mừng

Chốt ngày 11/11/2026, chưa code.

## 1. Theo dõi nhóm

### Quét và chọn nhóm
- Nút **Quét nhóm**: liệt kê mọi nhóm nick trợ lý đang ở, kèm số thành viên, nick có là quản trị không.
- Tích chọn nhóm muốn theo dõi. Từ lúc chọn, app chụp danh sách thành viên làm **mốc ban đầu**.
- Không lấy được lịch sử trước lúc bật theo dõi: Zalo không lưu ai vào/rời trước đó.

### Ghi nhận vào / rời
Hai nguồn, bù cho nhau:
- **Sự kiện tức thời** khi app đang chạy: vào nhóm (tự vào bằng link, được ai thêm vào, được duyệt yêu cầu), tự rời, bị mời ra, bị chặn.
- **Đối chiếu danh sách** mỗi ngày và mỗi lần app bật lại: so danh sách thành viên với lần trước. Người vào/rời lúc app tắt vẫn được đếm, ghi là *phát hiện khi đối chiếu* (không rõ giờ chính xác, không biết ai thêm vào).
- Vào rồi rời ngay trong lúc app tắt thì không thấy được (giới hạn của Zalo).

### Thống kê mỗi nhóm
- Thẻ số: thành viên hiện tại, vào mới, rời, tăng ròng trong kỳ.
- Chọn kỳ: **ngày / tuần / tháng** (và khoảng ngày tuỳ chọn); biểu đồ cột vào và rời theo từng ngày/tuần/tháng.
- Tách loại rời: tự rời / bị mời ra / bị chặn.
- Nguồn vào: qua link, được thành viên thêm (ai thêm nhiều nhất), duyệt yêu cầu.
- **Giữ chân**: trong số người vào kỳ này, bao nhiêu % còn ở lại sau 7 / 30 ngày.
- Danh sách chi tiết: ai vào, ai rời, lúc nào, ai thêm; lọc, tìm; xuất file CSV.
- Trang tổng: bảng so sánh các nhóm đang theo dõi.

## 2. Luồng chào mừng (bản đầu)

Bật riêng cho từng nhóm. Chỉ chạy khi app đang chạy.

### Chào trong nhóm
- Khi có người vào: chờ một khoảng (mặc định 2 phút) để **gom** những người vào cùng lúc thành **một** tin, tag tên từng người.
- Mẫu ví dụ: `Chào mừng {ten} đến với {ten_nhom}! Mọi người đọc nội quy ở tin ghim nhé.`

### Chào riêng (tin nhắn cá nhân)
- Gửi thẳng tin nhắn cho từng người mới (đã chốt: tin nhắn, không dùng lời mời kết bạn).
- Chống khoá nick: giãn cách ngẫu nhiên vài phút giữa các tin, **tối đa N tin/giờ và M tin/ngày** (mặc định thấp, chỉnh được), không gửi giờ khuya (mặc định 21:30–7:30, dồn sang sáng hôm sau).
- Người chặn tin từ người lạ sẽ không nhận được: ghi lại là *không gửi được*, không thử lại liên tục.

### Nội dung
- Mỗi kiểu chào (trong nhóm / riêng) có **2–3 mẫu**, app chọn ngẫu nhiên để tin không giống hệt nhau.
- Chỗ điền: `{ten}`, `{ten_nhom}`, `{so_thanh_vien}`, `{nguoi_them}`.
- Kèm ảnh được (dùng lại kho ảnh của Lịch gửi).
- Nút **Xem thử** hiện tin sẽ gửi với tên mẫu.

### Luật bỏ qua
- Không chào: nick trợ lý, chủ/phó nhóm, người vào lại trong vòng 30 ngày (đã chào rồi), người rời trước khi tới lượt gửi.
- Nhóm đang tắt luồng hoặc trợ lý đang **Tạm dừng toàn bộ** thì không gửi.
- Người mới nhắn lại sau lời chào riêng: hội thoại vào **Hộp thư** như bình thường; trợ lý trả lời nếu hội thoại có gắn nhãn tính cách.

### Nhật ký luồng
- Mỗi lần gửi ghi: ai, nhóm nào, trong nhóm hay riêng, đã gửi / chờ / không gửi được (lý do).

## 3. Rời nhóm
- Chỉ ghi vào thống kê (đã chốt). Không báo chuông, không nhắn hỏi lý do.

## 4. Để bản sau
- Chuỗi nhiều bước theo ngày (ngày 1 gửi tài liệu, ngày 3 hỏi thăm…), dừng khi người đó trả lời hoặc rời nhóm.
- Tự duyệt yêu cầu vào nhóm theo điều kiện.
- Tóm tắt nhóm hằng tuần gửi vào My Documents.

## 5. Ghi chú kỹ thuật (cho lúc code)
- zca-js có sự kiện `group_event`: `join`, `leave`, `remove_member`, `block_member`, `join_request` (kèm danh sách người, người thực hiện). Kênh Zalo hiện chưa nghe sự kiện này (`src/channels/zalo/channel.ts` mới nghe `message`, `typing`).
- Danh sách thành viên: `getGroupInfo` (`memVerList`, tổng số), tên/ảnh qua `getGroupMembersInfo`. Đã có `getAllGroups` + `getGroupInfo` cho việc liệt kê nhóm.
- Dữ liệu mới (migration): nhóm theo dõi, ảnh chụp thành viên, sự kiện vào/rời, cấu hình luồng, hàng đợi + nhật ký gửi. Mọi thứ riêng theo tài khoản Zalo như các phần khác.
- Hàng đợi gửi dùng chung bộ giới hạn tốc độ với tin chủ động (`pacing.ts`).
- Giao diện: thêm mục **Nhóm Zalo** ở thanh menu → danh sách nhóm → trang nhóm có 3 tab *Thống kê / Thành viên / Chào mừng*. Dựng qua skill evon:ui-ux (wireframe trước), theo `DESIGN.md`.
