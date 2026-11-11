/**
 * Đặt lại mật khẩu quản trị khi quên — chạy trên chính máy cài app:
 *   Bộ cài:        bấm đúp "Dat-lai-mat-khau" trong thư mục cài (gọi launcher.mjs --dat-lai-mat-khau)
 *   Mã nguồn:      npm run reset-password
 *   Tự đặt mật khẩu: thêm mật khẩu sau lệnh (ít nhất 8 ký tự)
 * Dữ liệu (Zalo, hộp thư, tính cách) giữ nguyên; mọi phiên đăng nhập cũ bị đăng xuất.
 */
import { Auth, readablePassword } from "./auth.js";
import { DATA_DIR } from "./config.js";
import { openDb } from "./db.js";

const wanted = process.argv[2]?.trim();
if (wanted?.startsWith("-")) {
  console.log("\nCách dùng: đặt lại mật khẩu quản trị Trợ lý CDN.");
  console.log("  Bỏ trống: app tạo mật khẩu mới dễ đọc. Hoặc ghi mật khẩu bạn muốn (ít nhất 8 ký tự) sau lệnh.\n");
  process.exit(0);
}
const password = wanted || readablePassword();
const db = openDb();
try {
  const username = new Auth(db).resetPassword(password);
  if (!username) {
    console.log("\nChưa có tài khoản quản trị. Mở app trên trình duyệt để tạo tài khoản lần đầu.\n");
  } else {
    console.log("\n  Đã đặt lại mật khẩu Trợ lý CDN.\n");
    console.log(`  Tên đăng nhập:  ${username}`);
    console.log(`  Mật khẩu mới:   ${password}\n`);
    console.log("  Ghi lại hai dòng trên rồi đăng nhập ở http://localhost:3000");
    console.log(`  (Dữ liệu: ${DATA_DIR})\n`);
  }
} catch (err) {
  console.error(`\nKhông đặt lại được: ${(err as Error).message}\n`);
  process.exitCode = 1;
} finally {
  db.close();
}
