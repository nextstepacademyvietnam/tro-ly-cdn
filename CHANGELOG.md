# Nhật ký thay đổi

Mỗi bản phát hành một mục. Mục của bản mới nhất hiện cho người dùng trong app khi có bản cập nhật,
nên viết bằng lời dễ hiểu, nói người dùng được gì. Đặt các thay đổi đang làm dưới **Chưa phát hành**;
lệnh `npm run release` sẽ đổi tiêu đề đó thành số bản kèm ngày.

Các nhóm dùng trong mỗi mục: `### Mới`, `### Sửa`, `### Lưu ý`. Bản có mục **Lưu ý** (việc người dùng
phải làm, hoặc thay đổi cần biết trước) thì thanh báo cập nhật trong app không cho ẩn.

## [Chưa phát hành]

### Mới
- **Khách chờ lâu**: khách nhắn riêng mà chưa ai trả lời quá 30 phút (kể cả khách chưa gắn nhãn) hiện trong **Cần xử lý**, kèm thời gian đã chờ. Bấm **Nhờ trợ lý soạn** để có nháp trả lời ngay (chọn tính cách nếu khách chưa có nhãn), hoặc **Không cần trả lời**. Tin chỉ là nhãn dán, "ok", "cảm ơn" không tính.
- **Gợi ý gắn nhãn**: khách mới nhắn riêng chưa có nhãn trợ lý, app nhờ AI xem đó là khách của tính cách nào (người nhà, nội bộ, đối tác thì không gợi ý). Gợi ý hiện ở cột thông tin và thẻ khách chờ; bạn bấm **Gắn nhãn** mới gắn.
- **Học từ cách bạn trả lời**: mỗi lần bạn tự trả lời khách hoặc sửa nháp trợ lý, app ghi lại. Mỗi ngày (khi có đủ lượt mới) hoặc khi bấm **Tìm gợi ý** ở trang **Tính cách**, AI rút thành câu hỏi đáp; bạn duyệt (sửa được) thì thêm vào hỏi đáp của tính cách. Kèm số nháp 30 ngày qua: gửi nguyên văn, bạn sửa, bỏ.
- Zalo mất kết nối quá 10 phút thì chuông báo cho bạn, nối lại được thì báo đã nối lại.
- **Báo về Zalo của bạn**: trợ lý nhắn vào khung "Cloud của tôi" trên Zalo khi khách cần bạn trực tiếp, khi nháp chờ duyệt quá 15 phút, và gửi tóm tắt lúc 17:30 mỗi ngày (tin khách đến, trợ lý đã gửi, việc còn tồn). Từ 21:30 tới 7:30 không nhắn, sáng gửi gộp. Bật / tắt và gửi thử ở trang **Tài khoản Zalo**.
- **Khách trong CRM** (khi đã nối Pancake CRM ở mục MKT): cột thông tin Hộp thư tra khách trong bảng lead và bảng đăng ký workshop theo số điện thoại trong hồ sơ Zalo, số khách gõ trong chat, hoặc số bạn nhập: trạng thái, sản phẩm đã chốt, người phụ trách, hẹn chăm sóc, nút mở bản ghi trong Pancake. App đọc lại CRM 6 giờ một lần. Nút **Lưu vào CRM** tạo bản ghi (tên, số điện thoại, ghi chú nhu cầu lấy sẵn từ hồ sơ chăm sóc hoặc các tin khách vừa hỏi, bạn sửa được) vào bảng bạn chọn; lần sau thì cập nhật đúng bản ghi đó, không tạo trùng. Khách vừa để lại số mà CRM chưa có thì chuông và Zalo của bạn báo để lưu.
- Trợ lý **nhớ khách khi trả lời**: hồ sơ chăm sóc (giai đoạn, thông tin, đã trao đổi, nhu cầu) và trạng thái trong CRM được đưa vào lúc soạn trả lời, không chỉ 30 tin gần nhất. Trợ lý vẫn không tự xác nhận thanh toán hay giữ chỗ.
- Tính cách để **Tự gửi**: một khách nhận quá 6 tin tự gửi trong 1 giờ hoặc 15 tin trong 24 giờ thì tin tiếp theo chuyển thành nháp chờ duyệt và chuông báo bạn, để hai bot không nhắn qua lại mãi và nick không bị Zalo hạn chế.
- **Chăm sóc khách chủ động**: bật trong trang **Tính cách**. Với mỗi khách chat riêng gắn nhãn tính cách đó, trợ lý đọc lại hội thoại, ghi **hồ sơ khách** (thông tin, những gì đã trao đổi, nhu cầu, giai đoạn) và đặt **lịch chăm sóc** tiếp theo: bao lâu một lần, ngày nào, lần tới cần làm gì, kèm lý do. Tới lịch, trợ lý **soạn sẵn tin chăm sóc** vào mục Cần xử lý để bạn duyệt rồi gửi, không tự gửi.
- Hộp thư, cột thông tin có thêm mục **Chăm sóc**: xem và sửa hồ sơ khách, đổi lịch (khoá để AI không tự đổi), tạm dừng, phân tích lại, xem lịch sử chăm sóc. Menu có thêm trang **Chăm sóc**: khách tới lượt hôm nay, sắp tới, tạm dừng, đã dừng.
- Trợ lý tự dừng chăm sóc người không phải khách (người nhà, nội bộ) và khách xin không nhận tin; không nhắn trong giờ yên lặng 21:30–07:30.
- **Nhóm Zalo → Thành viên nhắn riêng**: chọn một tính cách cho nhóm; ai trong nhóm nhắn riêng mà chưa có nhãn trợ lý sẽ được tự gắn nhãn Zalo của tính cách đó, trợ lý trả lời (và chăm sóc, nếu tính cách bật) luôn. Không đè nhãn có sẵn; người bạn đã gỡ nhãn thì không gắn lại.
- Chào riêng thành viên mới trong nhóm có thể **gửi kèm lời mời kết bạn** (bật / tắt được), người chặn tin từ người lạ vẫn nhận được lời mời.
- Trợ lý gọi khách đúng **anh**, **chị** theo giới tính trong hồ sơ Zalo của khách; chưa rõ giới tính thì gọi **bạn**. App không đoán giới tính từ tên.
- Hộp thư, cột **Khách** có thêm dòng **Gọi là**: xem trợ lý đang gọi khách thế nào, sai thì chọn lại (anh / chị / bạn), lựa chọn của bạn được giữ mãi.
- Bộ lọc Hộp thư thêm **Giới tính** (Nam, Nữ, Chưa rõ), chọn nhiều để lên lịch gửi riêng cho từng nhóm khách.
- Tin chào thành viên nhóm và lịch gửi tin có thêm biến **{xưng hô}** (và **{Xưng hô}** viết hoa đầu câu), **{tên}**: mỗi người nhận một tin gọi đúng anh, chị, bạn và đúng tên mình. Ô soạn lịch gửi có nút chèn biến và xem trước tin.
- Menu chia nhóm **Zalo / Cài đặt**; ô chuyển tài khoản Zalo nằm ngay trong nhóm Zalo.

### Sửa
- App không còn báo "Một tiến trình Trợ lý CDN khác đang giữ kết nối Zalo" sau khi bị tắt ngang rồi bật lại (máy cấp lại số tiến trình cũ cho chương trình khác). Khoá bỏ quên quá 2 phút được tự gỡ.
- Windows: app **tự bật lại** nếu bị tắt ngang hoặc treo (máy kiểm 5 phút một lần). Bấm "Tắt Trợ lý CDN" thì app nằm yên tới khi bạn mở lại. Bản cài từ trước: chạy lại file cài đặt để có phần này, dữ liệu giữ nguyên.
- Zalo **tự nối lại** khi rớt mạng hoặc máy vừa ngủ dậy (trước đây nằm im ở "Mất kết nối" tới khi bấm Kết nối lại, làm lỡ tin và lỡ lời chào nhóm). Người vào nhóm lúc mất kết nối vẫn được chào nếu chưa quá 24 giờ.
- Tải ảnh lớn (ảnh gốc điện thoại, ảnh thiết kế) cho lời chào và lịch gửi không còn lỗi: app tự thu nhỏ trước khi tải, có lỗi thì báo rõ.
- Số người vào nhóm không còn bị đếm trùng.

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
