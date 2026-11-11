import { addDays, dayCount, dayRange } from "./dates.js";
import type { Connection, MktKind, MktStore } from "./store.js";
import { LEAD_METRICS } from "./connectors/pancake.js";

/** Chỉ số tính tổng theo kỳ của từng nền tảng (followers là ảnh chụp, lấy số mới nhất). */
export const SUM_METRICS: Partial<Record<MktKind, string[]>> = {
  facebook: ["views", "comments", "posts", "follows", "engagement", "page_views"],
  youtube: ["views", "comments", "posts", "follows", "likes", "watch_minutes"],
  tiktok: ["views", "comments", "posts", "follows", "likes", "shares"],
  meta_ads: ["spend", "impressions", "clicks", "leads"],
  pancake: [...LEAD_METRICS],
};

export interface ChannelSummary {
  kind: MktKind;
  status: Connection["status"];
  label: string;
  error: string;
  dataUntil: string;
  /** Tổng của kỳ đang xem; null = kỳ này chưa có ngày nào có số. */
  totals: Record<string, number | null>;
  prev: Record<string, number | null>;
  /** Số từng ngày của kỳ đang xem (null = chưa có số). */
  series: Record<string, (number | null)[]>;
  followers: number | null;
}

export interface Summary {
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
  days: string[];
  channels: ChannelSummary[];
}

export function summarize(store: MktStore, from: string, to: string): Summary {
  const n = dayCount(from, to);
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(from, -n);
  const days = dayRange(from, to);
  const rows = store.daily(prevFrom, to);
  const channels: ChannelSummary[] = [];
  for (const conn of store.connections()) {
    const metrics = SUM_METRICS[conn.kind];
    if (!metrics) continue;
    const mine = rows.filter((r) => r.kind === conn.kind);
    const totals: Record<string, number | null> = {};
    const prev: Record<string, number | null> = {};
    const series: Record<string, (number | null)[]> = {};
    for (const m of metrics) {
      const byDay = new Map(mine.filter((r) => r.metric === m).map((r) => [r.day, r.value]));
      const cur = days.map((d) => byDay.get(d) ?? null);
      const before = dayRange(prevFrom, prevTo).map((d) => byDay.get(d) ?? null);
      series[m] = cur;
      totals[m] = sumOrNull(cur);
      prev[m] = sumOrNull(before);
    }
    const followers = store.daily("0000-01-01", to, [conn.kind]).filter((r) => r.metric === "followers").at(-1)?.value ?? null;
    channels.push({ kind: conn.kind, status: conn.status, label: conn.label, error: conn.error, dataUntil: conn.dataUntil, totals, prev, series, followers });
  }
  return { from, to, prevFrom, prevTo, days, channels };
}

const sumOrNull = (a: (number | null)[]) => (a.some((v) => v !== null) ? a.reduce<number>((s, v) => s + (v ?? 0), 0) : null);

/** Bảng từng ngày của một nền tảng (ngày mới nhất trước) — cho màn Kênh và file CSV. */
export function dailyTable(store: MktStore, kind: MktKind, from: string, to: string) {
  const metrics = SUM_METRICS[kind] ?? [];
  const rows = store.daily(from, to, [kind]);
  return dayRange(from, to)
    .reverse()
    .map((day) => ({ day, ...Object.fromEntries(metrics.map((m) => [m, rows.find((r) => r.day === day && r.metric === m)?.value ?? null])) }));
}
