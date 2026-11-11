/** Ngày theo giờ Việt Nam (UTC+7, không có giờ mùa hè), dạng YYYY-MM-DD. */
const VN_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;

export const vnDay = (ms: number): string => new Date(ms + VN_OFFSET_MS).toISOString().slice(0, 10);

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Các ngày từ `from` tới `to` (gồm cả hai đầu). */
export function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export const dayCount = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;

/** Mốc 00:00 giờ VN của một ngày (ms). */
export const vnMidnight = (day: string) => Date.parse(`${day}T00:00:00Z`) - VN_OFFSET_MS;

export const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
