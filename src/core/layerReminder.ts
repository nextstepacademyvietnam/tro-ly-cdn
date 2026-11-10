import type { DB } from "../server/db.js";
import type { AssistantStore } from "./assistantStore.js";
import { vnToday } from "./promptLayers.js";

const DAY = 86_400_000;
const STALE_DAYS = 7;

/**
 * Nhắc chủ giữ tầng 3 (thông tin thời điểm) luôn mới:
 * - ghi chú còn ≤ 2 ngày là hết hạn → nhắc một lần;
 * - tính cách đang gắn nhãn mà tầng 3 không được sửa trong 7 ngày → nhắc, tối đa mỗi tuần một lần.
 */
export function checkLayerReminders(db: DB, store: AssistantStore, now = Date.now()): number {
  let sent = 0;
  const soon = vnToday(now + 2 * DAY);
  const today = vnToday(now);
  const expiring = db
    .prepare(
      `SELECT n.id, n.text, n.expires_on, p.name, p.account_id FROM profile_notes n JOIN profiles p ON p.id = n.profile_id
       WHERE n.reminded = 0 AND n.expires_on IS NOT NULL AND n.expires_on >= ? AND n.expires_on <= ?`,
    )
    .all(today, soon) as { id: number; text: string; expires_on: string; name: string; account_id: number }[];
  for (const n of expiring) {
    const when = n.expires_on === today ? "hết hạn hôm nay" : `hết hạn ngày ${n.expires_on.split("-").reverse().join("/")}`;
    store.notify(n.account_id, "draft", `Tính cách "${n.name}": thông tin "${n.text.slice(0, 80)}" ${when}. Gia hạn hoặc thay thông tin mới ở tầng 3.`);
    db.prepare("UPDATE profile_notes SET reminded = 1 WHERE id = ?").run(n.id);
    sent++;
  }

  const stale = db
    .prepare(
      `SELECT p.id, p.name, p.account_id, p.created_at, p.stale_reminded_at,
              (SELECT MAX(updated_at) FROM profile_notes WHERE profile_id = p.id) AS last_note
       FROM profiles p WHERE p.tag <> ''`,
    )
    .all() as { id: number; name: string; account_id: number; created_at: number; stale_reminded_at: number; last_note: number | null }[];
  for (const p of stale) {
    const last = p.last_note ?? p.created_at;
    if (now - last < STALE_DAYS * DAY || now - p.stale_reminded_at < STALE_DAYS * DAY) continue;
    store.notify(
      p.account_id,
      "draft",
      `Tính cách "${p.name}": thông tin thời điểm (tầng 3) đã ${Math.floor((now - last) / DAY)} ngày chưa cập nhật. Kiểm tra khuyến mãi, lịch, số chỗ còn có còn đúng không.`,
    );
    db.prepare("UPDATE profiles SET stale_reminded_at = ? WHERE id = ?").run(now, p.id);
    sent++;
  }
  return sent;
}
