import { type ReactNode, useCallback, useEffect, useState } from "react";
import { ArrowDownRight, ArrowUpRight, ChevronRight, CirclePlay, Database, Download, Eye, Megaphone, MessageCircle, Music2, Plug, Sheet, ThumbsUp, X } from "lucide-react";
import { api, prefs } from "../../api";

export type Kind = "facebook" | "youtube" | "tiktok" | "meta_ads" | "pancake" | "gsheet";

export interface Conn {
  kind: Kind;
  name: string;
  available: boolean;
  status: "off" | "ok" | "error";
  error: string;
  label: string;
  dataUntil: string;
  pulledAt: number;
  connectedAt: number;
  running: boolean;
  hasApp?: boolean;
  appId?: string;
}

export interface ChannelSummary {
  kind: Kind;
  status: Conn["status"];
  label: string;
  error: string;
  dataUntil: string;
  totals: Record<string, number | null>;
  prev: Record<string, number | null>;
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

export interface Post {
  kind: Kind;
  postId: string;
  day: string;
  title: string;
  url: string;
  views: number | null;
  comments: number | null;
}

export const ICONS: Record<Kind, typeof ThumbsUp> = {
  facebook: ThumbsUp,
  youtube: CirclePlay,
  tiktok: Music2,
  meta_ads: Megaphone,
  pancake: Database,
  gsheet: Sheet,
};
export const NAMES: Record<Kind, string> = {
  facebook: "Facebook",
  youtube: "YouTube",
  tiktok: "TikTok",
  meta_ads: "Quảng cáo Meta",
  pancake: "Pancake CRM",
  gsheet: "Google Sheet",
};
/** Nhãn cột của từng chỉ số. */
export const METRIC_LABEL: Record<string, string> = {
  views: "Lượt xem",
  comments: "Bình luận",
  posts: "Bài",
  follows: "Theo dõi mới",
  engagement: "Tương tác",
  page_views: "Lượt xem trang",
  likes: "Lượt thích",
  shares: "Chia sẻ",
  watch_minutes: "Phút xem",
  spend: "Chi tiêu (₫)",
  impressions: "Hiển thị",
  clicks: "Lượt bấm",
  leads: "Lead",
  total: "Tổng lead",
  organic: "Content organic",
  lead_magnet: "Lead magnet",
  gia_tot: "Cộng đồng Giá Tốt",
  workshop: "Workshop",
  partner: "Đối tác",
  sale_team: "Sale, đội ngũ",
  alumni: "Học viên cũ",
  other: "Khác, chưa rõ",
  founder: "Founder",
};
/** Các nguồn lead (không gồm tổng và founder), theo thứ tự hiện. */
export const LEAD_SOURCES = ["organic", "lead_magnet", "gia_tot", "workshop", "partner", "sale_team", "alumni", "other"];

/** Thanh ngang lead theo nguồn, nhiều nhất ở trên; dòng cuối là tổng khử trùng và founder. */
export function LeadBars({ ch }: { ch: ChannelSummary }) {
  const rows = LEAD_SOURCES.map((k) => [k, ch.totals[k] ?? 0] as const).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...rows.map((r) => r[1]));
  return (
    <div className="mkt-leadbars">
      {rows.map(([k, v]) => (
        <div key={k} className="mkt-leadbar">
          <span className="n">{METRIC_LABEL[k]}</span>
          <span className="v tnum">{fmt(v)}</span>
          <span className="track">
            <span style={{ width: `${(v / max) * 100}%` }} />
          </span>
        </div>
      ))}
      <div className="mkt-leadbar-total">
        <span className="muted">Tổng lead (khử trùng) · founder</span>
        <span className="tnum">
          {fmt(ch.totals.total)} · {fmt(ch.totals.founder)}
        </span>
      </div>
    </div>
  );
}

// ---------- Số ----------
export const fmt = (n: number | null | undefined) => (n === null || n === undefined ? "—" : Math.round(n).toLocaleString("vi-VN"));
/** Số gọn: 160,6k · 9,7 tr. */
export const compact = (n: number | null | undefined) => {
  if (n === null || n === undefined) return "—";
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} tr`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e3).toLocaleString("vi-VN", { maximumFractionDigits: 1 })}k`;
  return fmt(n);
};
export const dm = (day: string) => (day ? `${day.slice(8, 10)}/${day.slice(5, 7)}` : "");
const WD = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
export const wdm = (day: string) => `${WD[new Date(`${day}T00:00:00Z`).getUTCDay()]} ${dm(day)}`;

/** % thay đổi so với kỳ trước; null khi kỳ trước không có số hoặc bằng 0. */
export const pct = (cur: number | null | undefined, prev: number | null | undefined) =>
  cur === null || cur === undefined || !prev ? null : Math.round(((cur - prev) / prev) * 100);

export function Delta({ value }: { value: number | null }) {
  if (value === null) return <span className="mkt-delta same">—</span>;
  if (value === 0) return <span className="mkt-delta same">như kỳ trước</span>;
  const Icon = value > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={value > 0 ? "mkt-delta up" : "mkt-delta down"} title="So với kỳ trước">
      <Icon aria-hidden />
      {Math.abs(value)}%
    </span>
  );
}

// ---------- Khoảng ngày ----------
export type RangeKey = "hom-qua" | "7" | "30" | "thang";
export const RANGES: { key: RangeKey; label: string }[] = [
  { key: "hom-qua", label: "Hôm qua" },
  { key: "7", label: "7 ngày" },
  { key: "30", label: "30 ngày" },
  { key: "thang", label: "Tháng này" },
];
const vnToday = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const add = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Kỳ kết thúc ở hôm qua (hôm nay chưa đủ số); "Tháng này" từ mùng 1 tới hôm qua. */
export function rangeOf(key: RangeKey): { from: string; to: string } {
  const to = add(vnToday(), -1);
  if (key === "hom-qua") return { from: to, to };
  if (key === "30") return { from: add(to, -29), to };
  if (key === "thang") {
    const first = `${vnToday().slice(0, 8)}01`;
    return { from: first <= to ? first : to, to };
  }
  return { from: add(to, -6), to };
}

export function useRange() {
  const [key, setKey] = useState<RangeKey>(() => (prefs.get("mkt.ky") as RangeKey) || "7");
  const choose = (k: RangeKey) => {
    prefs.set("mkt.ky", k);
    setKey(k);
  };
  return { key, choose, ...rangeOf(key) };
}

export function RangeBar({ range, note }: { range: ReturnType<typeof useRange>; note?: ReactNode }) {
  return (
    <div className="mkt-range">
      <div className="grp-seg mkt-range-seg" role="tablist" aria-label="Khoảng ngày">
        {RANGES.map((r) => (
          <button key={r.key} type="button" role="tab" aria-selected={range.key === r.key} onClick={() => range.choose(r.key)}>
            {r.label}
          </button>
        ))}
      </div>
      <span className="muted small">
        {range.from === range.to ? dm(range.from) : `${dm(range.from)} – ${dm(range.to)}`} · so với kỳ trước
      </span>
      {note && <span className="mkt-range-note muted">{note}</span>}
    </div>
  );
}

/** Tải lại khi đổi khoảng ngày hoặc khi bấm Làm mới (sự kiện "mkt:lam-moi" từ header). */
export function useMktData<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    if (!path) return;
    api<T>(path)
      .then((d) => {
        setData(d);
        setError("");
      })
      .catch((err) => setError((err as Error).message));
  }, [path]);
  useEffect(() => {
    load();
    const on = () => load();
    window.addEventListener("mkt:lam-moi", on);
    return () => window.removeEventListener("mkt:lam-moi", on);
  }, [load]);
  return { data, error, load };
}

// ---------- Khối dùng chung ----------
export function KindIcon({ kind }: { kind: Kind }) {
  const Icon = ICONS[kind];
  return (
    <span className="mkt-kind-ic">
      <Icon aria-hidden />
    </span>
  );
}

export function KpiCard({ label, value, delta, sub }: { label: string; value: string; delta: number | null; sub: string }) {
  return (
    <div className="card mkt-kpi">
      <div className="l">{label}</div>
      <div className="v-row">
        <span className="v tnum">{value}</span>
        {value !== "—" && <Delta value={delta} />}
      </div>
      <div className="s">{sub}</div>
    </div>
  );
}

/** Ba số chính của từng nền tảng trên thẻ kênh. */
const CARD_METRICS: Partial<Record<Kind, [string, string][]>> = {
  facebook: [["views", "Lượt xem"], ["comments", "Bình luận"], ["follows", "Theo dõi mới"]],
  youtube: [["views", "Lượt xem"], ["comments", "Bình luận"], ["follows", "Đăng ký mới"]],
  tiktok: [["views", "Lượt xem"], ["comments", "Bình luận"], ["follows", "Theo dõi mới"]],
  meta_ads: [["spend", "Chi tiêu"], ["impressions", "Hiển thị"], ["clicks", "Lượt bấm"]],
};

export function ChannelCard({ ch, conn, onDetail, onConnect }: { ch?: ChannelSummary; conn: Conn; onDetail: () => void; onConnect: () => void }) {
  const metrics = CARD_METRICS[conn.kind] ?? [];
  if (!ch || conn.status === "off") {
    return (
      <div className="card mkt-ch off">
        <KindIcon kind={conn.kind} />
        <div>
          <div className="mkt-ch-name">{conn.name}</div>
          <p className="muted small">{conn.available ? "Chưa nối. Nối để xem lượt xem, bình luận, người theo dõi." : "Sắp có trong bản cập nhật tới."}</p>
        </div>
        {conn.available ? (
          <button type="button" className="primary" onClick={onConnect}>
            <Plug aria-hidden />
            Kết nối
          </button>
        ) : (
          <span className="badge mkt-badge off">Sắp có</span>
        )}
      </div>
    );
  }
  const main = metrics[0]?.[0] ?? "views";
  const series = ch.series[main] ?? [];
  const max = Math.max(1, ...series.map((v) => v ?? 0));
  return (
    <div className="card mkt-ch">
      <div className="mkt-ch-head">
        <KindIcon kind={conn.kind} />
        <div className="mkt-ch-title">
          <div className="mkt-ch-name">
            {conn.name}
            {conn.status === "error" && <span className="badge mkt-badge bad">Lỗi</span>}
          </div>
          <div className="mkt-ch-sub">
            {ch.label || conn.label}
            {ch.dataUntil && ` · số tới ${dm(ch.dataUntil)}`}
          </div>
        </div>
        <button type="button" className="ghost small-btn" onClick={onDetail}>
          Chi tiết
          <ChevronRight aria-hidden />
        </button>
      </div>
      {conn.status === "error" && <div className="mkt-err-box">{conn.error}</div>}
      <div className="mkt-ch-nums">
        {metrics.map(([m, l]) => (
          <div key={m}>
            <div className="l">{l}</div>
            <div className="v tnum">
              {m === "follows" && (ch.totals[m] ?? 0) > 0 ? "+" : ""}
              {m === "spend" ? `${compact(ch.totals[m])} ₫` : compact(ch.totals[m])}
            </div>
            <Delta value={pct(ch.totals[m], ch.prev[m])} />
          </div>
        ))}
      </div>
      <div className="mkt-spark" aria-hidden>
        {series.map((v, i) => (
          <span key={i} className={v === null ? "none" : ""} style={v === null ? undefined : { height: `${Math.max(4, (v / max) * 40)}px` }} />
        ))}
      </div>
    </div>
  );
}

export function TopPosts({ posts, empty = "Chưa có bài nào trong khoảng này." }: { posts: Post[]; empty?: string }) {
  if (!posts.length) return <p className="muted small mkt-pad">{empty}</p>;
  return (
    <ul className="mkt-posts">
      {posts.map((p) => (
        <li key={`${p.kind}-${p.postId}`}>
          <a href={p.url} target="_blank" rel="noreferrer" title={`Mở bài trên ${NAMES[p.kind]}`}>
            <span className="t">{p.title}</span>
            <span className="m">
              <span className="w">
                {NAMES[p.kind]} · {dm(p.day)}
              </span>
              <span className="n tnum">
                <Eye aria-hidden />
                {fmt(p.views)}
              </span>
              <span className="n tnum">
                <MessageCircle aria-hidden />
                {fmt(p.comments)}
              </span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

export function DailyTable({ kind, from, to }: { kind: Kind; from: string; to: string }) {
  const { data } = useMktData<{ metrics: string[]; rows: Record<string, number | string | null>[] }>(`/api/mkt/daily?kind=${kind}&from=${from}&to=${to}`);
  if (!data) return <p className="muted small mkt-pad">Đang tải…</p>;
  const total = (m: string) => {
    const vals = data.rows.map((r) => r[m]).filter((v): v is number => typeof v === "number");
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  return (
    <div className="grp-table-wrap">
      <table className="grp-table mkt-table">
        <thead>
          <tr>
            <th>Ngày</th>
            {data.metrics.map((m) => (
              <th key={m} className="num">
                {METRIC_LABEL[m] ?? m}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={String(r.day)}>
              <td>{wdm(String(r.day))}</td>
              {data.metrics.map((m) => (
                <td key={m} className={r[m] === null ? "num muted" : "num"}>
                  {m === "follows" && typeof r[m] === "number" && (r[m] as number) > 0 ? "+" : ""}
                  {fmt(r[m] as number | null)}
                </td>
              ))}
            </tr>
          ))}
          <tr className="mkt-total">
            <td>Tổng</td>
            {data.metrics.map((m) => (
              <td key={m} className="num">
                {fmt(total(m))}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export const csvUrl = (kind: Kind, from: string, to: string) => `/api/mkt/daily.csv?kind=${kind}&from=${from}&to=${to}`;

/** Panel trượt từ phải: số từng ngày và top bài của một kênh. */
export function DetailDrawer({ kind, label, from, to, onClose }: { kind: Kind | null; label: string; from: string; to: string; onClose: () => void }) {
  const { data } = useMktData<{ posts: Post[] }>(kind ? `/api/mkt/posts?kind=${kind}&from=${from}&to=${to}&limit=8` : null);
  useEffect(() => {
    if (!kind) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [kind, onClose]);
  return (
    <>
      <div className={kind ? "scrim open" : "scrim"} onClick={onClose} />
      <aside className={kind ? "mkt-drawer open" : "mkt-drawer"} aria-label="Chi tiết kênh" aria-hidden={!kind}>
        {kind && (
          <>
            <div className="mkt-drawer-head">
              <KindIcon kind={kind} />
              <div className="mkt-ch-title">
                <div className="mkt-ch-name">
                  {NAMES[kind]}
                  {label && ` · ${label}`}
                </div>
                <div className="mkt-ch-sub">
                  {dm(from)} – {dm(to)}
                </div>
              </div>
              <a className="icon-only mkt-icon-link" href={csvUrl(kind, from, to)} aria-label="Xuất CSV" title="Xuất CSV">
                <Download aria-hidden />
              </a>
              <button type="button" className="icon-only" onClick={onClose} aria-label="Đóng">
                <X aria-hidden />
              </button>
            </div>
            <div className="mkt-drawer-body">
              <DailyTable kind={kind} from={from} to={to} />
              <h2 className="mkt-h2">Top bài</h2>
              <TopPosts posts={data?.posts ?? []} />
            </div>
          </>
        )}
      </aside>
    </>
  );
}

export function useConnections() {
  return useMktData<{ connections: Conn[]; runs: { kind: Kind; ok: boolean; message: string; at: number }[] }>("/api/mkt/connections");
}
