/**
 * Nhận báo lỗi, góp ý từ app Trợ lý CDN và ghi vào Google Sheet này.
 * Mỗi lần gửi = một dòng ở trang tính "Báo lỗi". Ảnh chụp màn hình lưu vào thư mục Drive
 * "Trợ lý CDN - ảnh báo lỗi", ô Ảnh là đường dẫn tới ảnh.
 * Cách dựng: xem docs/gop-y-google-sheet.md trong repo.
 */

// Muốn nhận email mỗi khi có báo lỗi mới thì điền email vào đây, để trống là không gửi.
const NOTIFY_EMAIL = "";

const SHEET_NAME = "Báo lỗi";
const FOLDER_NAME = "Trợ lý CDN - ảnh báo lỗi";
const HEADERS = ["Thời gian", "Loại", "Nội dung", "Liên hệ", "Bản app", "Cách cài", "Máy", "Trình duyệt", "Trang", "Ảnh", "Trạng thái"];

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    const sheet = getSheet();
    let link = "";
    if (d.screenshot) {
      const blob = Utilities.newBlob(Utilities.base64Decode(d.screenshot), "image/jpeg", "bao-loi-" + Date.now() + ".jpg");
      link = getFolder().createFile(blob).getUrl();
    }
    sheet.appendRow([
      new Date(),
      safe(d.kind),
      safe(d.message),
      safe(d.contact),
      safe(d.version),
      safe(d.installKind),
      safe(d.system),
      safe(d.browser),
      safe(d.page),
      link,
      "Mới",
    ]);
    if (NOTIFY_EMAIL) {
      MailApp.sendEmail(NOTIFY_EMAIL, "[Trợ lý CDN] " + (d.kind || "Báo lỗi") + " mới", (d.message || "") + "\n\nLiên hệ: " + (d.contact || "-") + "\nẢnh: " + (link || "-") + "\n\nXem tất cả: " + SpreadsheetApp.getActiveSpreadsheet().getUrl());
    }
    return reply({ ok: true });
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  }
}

/** Mở link web app trên trình duyệt để kiểm tra đã triển khai đúng chưa. */
function doGet() {
  return reply({ ok: true, message: "Nơi nhận báo lỗi Trợ lý CDN đang chạy." });
}

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold");
    sheet.setColumnWidth(3, 420);
  }
  return sheet;
}

function getFolder() {
  const found = DriveApp.getFoldersByName(FOLDER_NAME);
  return found.hasNext() ? found.next() : DriveApp.createFolder(FOLDER_NAME);
}

/** Chữ người dùng gõ: chặn bị hiểu thành công thức (=, +, -, @) và giữ số 0 đầu số điện thoại. */
function safe(v) {
  const s = String(v == null ? "" : v).slice(0, 5000);
  return /^[=+\-@0]/.test(s) ? "'" + s : s;
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
