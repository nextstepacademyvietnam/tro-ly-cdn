# Phát hành bản mới

Khách đã cài app sẽ thấy thanh báo "Có bản mới" trong vòng 6 giờ sau khi bạn phát hành, và cập nhật bằng một nút bấm.

> Repo phải ở chế độ **công khai** thì máy khách mới đọc được bản phát hành. Repo riêng tư thì app im lặng, không báo gì.

## 5 bước

1. **Ghi thay đổi** vào `CHANGELOG.md`, dưới mục `## [Chưa phát hành]`. Viết cho khách đọc: họ được gì, phải làm gì.
   ```markdown
   ## [Chưa phát hành]

   ### Mới
   - Thư ký tóm tắt tin nhắn cuối ngày.

   ### Sửa
   - Ảnh gửi theo lịch không còn bị xoay ngang.

   ### Lưu ý
   - Sau khi cập nhật, vào Tài khoản Zalo quét mã QR lại một lần.
   ```
   Có mục **Lưu ý** thì thanh báo trong app không cho khách ẩn đi.
2. **Commit** mọi thay đổi lên nhánh `main`.
3. **Chạy lệnh phát hành**, chọn mức tăng số bản:
   ```bash
   npm run release -- patch    # chỉ sửa lỗi: 0.2.0 → 0.2.1
   npm run release -- minor    # thêm tính năng: 0.2.0 → 0.3.0
   npm run release -- major    # thay đổi lớn, khách phải làm gì đó: 0.2.0 → 1.0.0
   ```
   Lệnh tự chạy typecheck, test, build. Lỗi ở đâu thì dừng ở đó, chưa ghi gì. Qua hết thì nó nâng số bản, chốt CHANGELOG, commit, gắn tag và đẩy lên GitHub.
   Muốn thử trước mà không ghi gì: thêm `--dry-run`.
4. **Chờ GitHub Actions** (tab Actions, việc "Phát hành", khoảng 3–5 phút). Nó build lại, đóng gói `tro-ly-cdn-vX.Y.Z.tar.gz` kèm `SHA256SUMS`, rồi tạo Release với ghi chú lấy từ CHANGELOG.
5. **Mở trang Releases** trên GitHub, xem ghi chú hiển thị đúng. Xong: máy khách tự thấy.

## Khi có sự cố

- **Actions báo đỏ**: chưa có Release nên khách chưa thấy gì. Sửa lỗi, xoá tag (`git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`), chạy lại bước 3.
- **Release lỡ có lỗi**: đừng xoá Release (máy khách có thể đang tải). Sửa rồi phát hành ngay bản `patch` kế tiếp.
- **Khách báo cập nhật lỗi**: app đã tự quay về bản cũ và chép lại dữ liệu. Bản sao lưu nằm ở `data/backups/truoc-<số bản>-<ngày giờ>.sqlite` trên máy khách.

## Bảo trì định kỳ

- Dependabot mở PR nâng cấp thư viện mỗi tuần. CI xanh thì gộp, rồi phát hành `patch` khi gom đủ.
- `zca-js` (kết nối Zalo) không tự nâng. Nâng tay, thử với nick Zalo phụ thật trước khi phát hành.
