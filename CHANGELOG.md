# Nhật ký thay đổi

Mỗi bản phát hành một mục. Mục của bản mới nhất hiện cho người dùng trong app khi có bản cập nhật,
nên viết bằng lời dễ hiểu, nói người dùng được gì. Đặt các thay đổi đang làm dưới **Chưa phát hành**;
lệnh `npm run release` sẽ đổi tiêu đề đó thành số bản kèm ngày.

Các nhóm dùng trong mỗi mục: `### Mới`, `### Sửa`, `### Lưu ý`. Bản có mục **Lưu ý** (việc người dùng
phải làm, hoặc thay đổi cần biết trước) thì thanh báo cập nhật trong app không cho ẩn.

## [Chưa phát hành]

### Mới
- **Nhóm Zalo: giới hạn tự gửi tính theo từng người**: trước đây nhóm cũng chỉ được 6 tin trợ lý/giờ như chat riêng, nhóm đông người hỏi là trợ lý dừng (giữ nháp). Giờ trong nhóm tính 6 tin/giờ cho mỗi người hỏi, cả nhóm tối đa 20 tin/giờ và 60 tin/ngày.
- **Nhóm Zalo: gọi trợ lý không cần tag**: gõ "admin ơi", "ad ơi", "trợ lý ơi", "bot ơi", "BTC ơi" (có dấu hay không dấu) trong nhóm cũng tính là gọi trợ lý; sửa danh sách từ gọi ở khung thông tin nhóm trong Hộp thư. Người vừa được trợ lý trả lời hỏi tiếp trong 10 phút thì không cần gọi lại. Tin đang tag hoặc trả lời người khác thì trợ lý không chen vào.
- **Nhóm Zalo: trợ lý tự trả lời câu hỏi**: trong Hộp thư, mở một nhóm → khung thông tin → tích "Tự trả lời câu hỏi trong nhóm". Trợ lý đọc mọi tin, chỉ trả lời câu hỏi chung mà tài liệu trả lời được (tối đa 4 tin/giờ mỗi nhóm); chuyện trò, câu hỏi dành cho người khác, chuyện tiền thì im lặng. Nhóm không bật thì vẫn chỉ trả lời khi được tag hoặc được trả lời vào tin. Bạn nhắn tay trong nhóm giờ chỉ làm trợ lý nhường 5 phút (trước là 30 phút); chat riêng vẫn 30 phút.
- **Lịch gửi do AI soạn**: ở mục Nội dung của lịch chọn "AI viết mới mỗi lượt", nhập chủ đề (VD mỗi sáng một mẹo bán hàng cho nhóm). Đến giờ AI viết một tin mới theo tính cách và tài liệu đã chọn, không lặp các tin đã gửi. Chế độ "chờ duyệt" đưa tin vào Cần xử lý của từng hội thoại, duyệt rồi mới gửi (giữ @All và mức độ); chế độ "tự gửi" gửi luôn. Lịch sử lượt gửi hiện nguyên văn tin AI đã viết.
- **Lịch gửi: tag tất cả và mức độ tin**: khi lên lịch gửi vào nhóm, tích "Tag tất cả mọi người" để thêm @All ở đầu tin (cả nhóm nhận thông báo). Chọn mức độ Thường / Quan trọng / Khẩn cấp để Zalo gắn nhãn lên tin. Danh sách lịch hiện nhãn @All và mức độ.
- **Bản doanh nghiệp (đợt 1)**: Cài đặt → **Doanh nghiệp** nối app trên máy với công ty (dán mã kết nối quản lý gửi, nhập email, nhập mã xác nhận). Công ty dùng Supabase và trang quản lý riêng (thư mục `org/`, chạy trên Vercel): tạo công ty, mời nhân viên, xem máy và nick Zalo đang chạy. Tin nhắn khách vẫn chỉ nằm trên máy. Dùng một mình thì không cần nối. Hướng dẫn cài ở `org/README.md`. Ba vai: chủ công ty, quản lý, nhân viên kinh doanh; bảng "Vai trò và quyền" ở trang Thành viên, chủ công ty chuyển được quyền chủ cho người khác.
- **Admin ra lệnh qua Zalo**: thêm người làm admin ở trang **Tài khoản Zalo** (chọn từ Hộp thư). Admin nhắn riêng cho nick bot bằng lời tự nhiên để thêm khuyến mãi, lịch khai giảng (có hạn), câu hỏi đáp; tạm dừng hoặc bật lại trợ lý, bật tắt chăm sóc; hỏi số liệu, tóm tắt một khách; gắn nhãn cho khách. Bot hỏi lại khi lệnh chưa rõ (VD có nhiều tính cách), trả lời rõ đã làm gì, gõ "hoàn tác" để huỷ. Chính nick bot ra lệnh trong "Cloud của tôi" bằng cách mở đầu tin bằng "bot" hoặc "/". Bot không gửi tin cho khách theo lệnh admin.
- **Báo cáo định kỳ**: đặt lịch hằng ngày hoặc hằng tuần (chọn thứ, giờ), chọn người nhận (Cloud của tôi, các admin) và chỉ số (tin khách, khách mới, tin trợ lý gửi, thời gian phản hồi, tỉ lệ nháp dùng nguyên văn, nháp chờ, khách chờ lâu, chờ người thật, chăm sóc, nhóm Zalo, CRM). Có xem trước và gửi ngay. Tóm tắt 17:30 cũ chuyển thành một báo cáo hằng ngày, sửa được.
- **Khách chờ lâu**: khách nhắn riêng mà chưa ai trả lời quá 30 phút (kể cả khách chưa gắn nhãn) hiện trong **Cần xử lý**, kèm thời gian đã chờ. Bấm **Nhờ trợ lý soạn** để có nháp trả lời ngay (chọn tính cách nếu khách chưa có nhãn), hoặc **Không cần trả lời**. Tin chỉ là nhãn dán, "ok", "cảm ơn" không tính.
- **Gợi ý gắn nhãn**: khách mới nhắn riêng chưa có nhãn trợ lý, app nhờ AI xem đó là khách của tính cách nào (người nhà, nội bộ, đối tác thì không gợi ý). Gợi ý hiện ở cột thông tin và thẻ khách chờ; bạn bấm **Gắn nhãn** mới gắn.
- **Học từ cách bạn trả lời**: mỗi lần bạn tự trả lời khách hoặc sửa nháp trợ lý, app ghi lại. Mỗi ngày (khi có đủ lượt mới) hoặc khi bấm **Tìm gợi ý** ở trang **Tính cách**, AI rút thành câu hỏi đáp; bạn duyệt (sửa được) thì thêm vào hỏi đáp của tính cách. Kèm số nháp 30 ngày qua: gửi nguyên văn, bạn sửa, bỏ.
- Zalo mất kết nối quá 10 phút thì chuông báo cho bạn, nối lại được thì báo đã nối lại.
- **Báo về Zalo của bạn**: trợ lý nhắn vào khung "Cloud của tôi" trên Zalo khi khách cần bạn trực tiếp, khi nháp chờ duyệt quá 15 phút, và gửi tóm tắt lúc 17:30 mỗi ngày (tin khách đến, trợ lý đã gửi, việc còn tồn). Từ 21:30 tới 7:30 không nhắn, sáng gửi gộp. Bật / tắt và gửi thử ở trang **Tài khoản Zalo**.
- **Khách trong CRM** (khi đã nối Pancake CRM ở mục MKT): app lấy số điện thoại của lead trong CRM, nhờ Zalo tìm ra đúng tài khoản Zalo, nên khách nhắn Zalo là cột thông tin Hộp thư biết ngay họ là ai trong CRM, **không cần tên Zalo giống tên CRM**. Tìm chậm có trần (tối đa 40 số mỗi nick mỗi ngày, nghỉ ban đêm, Zalo nhắc thì nghỉ 1 ngày rồi lâu dần), khách đang theo trước rồi tới lead cũ; tiến độ xem ở thẻ Pancake trang **MKT · Kết nối**. Vẫn tra thêm được theo số trong hồ sơ Zalo, số khách gõ trong chat, hoặc số bạn nhập. Hiện ra: trạng thái, sản phẩm đã chốt, người phụ trách, hẹn chăm sóc, nút mở bản ghi trong Pancake. App đọc lại CRM 6 giờ một lần. Nút **Lưu vào CRM** tạo bản ghi (tên, số điện thoại, ghi chú nhu cầu lấy sẵn từ hồ sơ chăm sóc hoặc các tin khách vừa hỏi, bạn sửa được) vào bảng bạn chọn; lần sau thì cập nhật đúng bản ghi đó, không tạo trùng. Khách vừa để lại số mà CRM chưa có thì chuông và Zalo của bạn báo để lưu.
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
- Tin chào riêng (và tin trợ lý gửi) không còn bị ghi nhầm là bạn tự gõ tay. Trước đây khi Zalo báo lại tin nhanh hơn lệnh gửi, app tưởng bạn vừa nhắn nên trợ lý im 30 phút, khách trả lời lời chào mà không ai đáp.
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
