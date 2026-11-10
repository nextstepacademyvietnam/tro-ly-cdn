/**
 * Tính thời điểm gửi theo lịch, theo giờ Việt Nam (UTC+7, không có giờ mùa hè).
 */
export type RecurrenceType = "once" | "daily" | "weekly" | "monthly";

export interface Recurrence {
  type: RecurrenceType;
  /** Ngày gửi (once) hoặc ngày bắt đầu (lặp), dạng YYYY-MM-DD. */
  date: string;
  /** Giờ gửi HH:MM. */
  time: string;
  /** weekly: các thứ trong tuần, 0 = Chủ nhật … 6 = Thứ bảy. */
  weekdays?: number[];
  /** monthly: ngày trong tháng 1–31; tháng ngắn hơn thì gửi ngày cuối tháng. */
  monthDay?: number;
  /** Ngày kết thúc (gồm cả ngày đó), YYYY-MM-DD. */
  endDate?: string;
}

const VN_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Mốc thời gian (ms) của ngày + giờ theo giờ Việt Nam. */
export function vnTime(date: string, time: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) - VN_OFFSET_MS;
}

/** Ngày YYYY-MM-DD theo giờ Việt Nam của một mốc thời gian. */
export function vnDate(ms: number): string {
  return new Date(ms + VN_OFFSET_MS).toISOString().slice(0, 10);
}

export function vnHour(ms: number): number {
  return new Date(ms + VN_OFFSET_MS).getUTCHours();
}

/** Nửa đêm UTC của một ngày YYYY-MM-DD — dùng làm "ô ngày" khi duyệt lịch. */
function dayUtc(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export class RecurrenceError extends Error {}

export function validateRecurrence(r: Recurrence): void {
  if (!["once", "daily", "weekly", "monthly"].includes(r.type)) throw new RecurrenceError("Kiểu lặp không hợp lệ");
  if (!DATE_RE.test(r.date) || Number.isNaN(vnTime(r.date, "00:00"))) throw new RecurrenceError("Ngày không hợp lệ");
  if (!TIME_RE.test(r.time)) throw new RecurrenceError("Giờ không hợp lệ (HH:MM)");
  if (r.type === "weekly") {
    if (!r.weekdays?.length || r.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      throw new RecurrenceError("Chọn ít nhất một thứ trong tuần");
    }
  }
  if (r.type === "monthly" && (!Number.isInteger(r.monthDay) || r.monthDay! < 1 || r.monthDay! > 31)) {
    throw new RecurrenceError("Ngày trong tháng phải từ 1 đến 31");
  }
  if (r.endDate !== undefined) {
    if (!DATE_RE.test(r.endDate)) throw new RecurrenceError("Ngày kết thúc không hợp lệ");
    if (r.endDate < r.date) throw new RecurrenceError("Ngày kết thúc phải sau ngày bắt đầu");
  }
}

function matchesDay(r: Recurrence, dayMs: number): boolean {
  const d = new Date(dayMs);
  switch (r.type) {
    case "daily":
      return true;
    case "weekly":
      return r.weekdays!.includes(d.getUTCDay());
    case "monthly": {
      const target = Math.min(r.monthDay!, daysInMonth(d.getUTCFullYear(), d.getUTCMonth() + 1));
      return d.getUTCDate() === target;
    }
    default:
      return false;
  }
}

/** Lượt gửi kế tiếp sau `afterMs` (không gồm chính nó), hoặc null nếu lịch đã hết. */
export function nextRun(r: Recurrence, afterMs: number): number | null {
  if (r.type === "once") {
    const t = vnTime(r.date, r.time);
    return t > afterMs ? t : null;
  }
  const startDay = dayUtc(r.date);
  const afterDay = dayUtc(vnDate(afterMs));
  const endDay = r.endDate ? dayUtc(r.endDate) : Infinity;
  const [hh, mm] = r.time.split(":").map(Number);
  // Duyệt tối đa ~13 tháng là đủ cho mọi kiểu lặp (hằng tháng ngày 31 vẫn gặp ngày cuối tháng).
  for (let day = Math.max(startDay, afterDay), i = 0; i < 400 && day <= endDay; day += DAY_MS, i++) {
    if (!matchesDay(r, day)) continue;
    const t = day + (hh * 60 + mm) * 60_000 - VN_OFFSET_MS;
    if (t > afterMs) return t;
  }
  return null;
}

const WEEKDAY_VN = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];

/** Mô tả ngắn cho người dùng, ví dụ "Mỗi T2, T4, T6 lúc 08:00". */
export function describeRecurrence(r: Recurrence): string {
  const [y, m, d] = r.date.split("-");
  const end = r.endDate ? ` đến ${r.endDate.split("-").reverse().join("/")}` : "";
  switch (r.type) {
    case "once":
      return `Một lần, ${d}/${m}/${y} lúc ${r.time}`;
    case "daily":
      return `Hằng ngày lúc ${r.time}${end}`;
    case "weekly":
      return `Mỗi ${[...r.weekdays!].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((w) => WEEKDAY_VN[w]).join(", ")} lúc ${r.time}${end}`;
    case "monthly":
      return `Ngày ${r.monthDay} hằng tháng lúc ${r.time}${end}`;
  }
}
