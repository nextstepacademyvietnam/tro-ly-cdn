import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  Ban,
  CalendarDays,
  Check,
  ChevronRight,
  Download,
  HandHeart,
  ImagePlus,
  LogOut,
  Plus,
  RefreshCw,
  ScanSearch,
  Search,
  TriangleAlert,
  UserMinus,
  UserPlus,
  Users,
  WifiOff,
  X,
} from "lucide-react";
import { type Account, api, getCurrentAccount, readAsBase64 } from "../api";
import { Popover } from "../ui";

// ---------- Kiểu dữ liệu (khớp src/server/routes/groups.ts) ----------
interface GroupSummary {
  id: string;
  name: string;
  memberCount: number;
  trackedAt: number;
  reconciledAt: number;
  joins7d: number;
  leaves7d: number;
  welcomeOn: boolean;
}
interface ScanGroup {
  id: string;
  name: string;
  memberCount: number;
  isAdmin: boolean;
  tracked: boolean;
}
type Bucket = "day" | "week" | "month";
interface Retention {
  cohort: number;
  stayed: number;
  percent: number;
}
interface Stats {
  currentMembers: number;
  totals: { joins: number; leaves: number; net: number; leaveBy: { leave: number; remove: number; block: number }; joinBy: { link: number; added: number; diff: number } };
  series: { key: string; joins: number; leaves: number }[];
  topAdders: { name: string; count: number }[];
  retention: { d7: Retention | null; d30: Retention | null };
  trackedAt: number;
  reconciledAt: number;
}
interface GroupEvent {
  id: number;
  user_id: string;
  user_name: string;
  kind: "join" | "leave" | "remove" | "block";
  via: string;
  actor_id: string;
  actor_name: string;
  at: number;
}
interface WelcomeConfig {
  enabled: boolean;
  group: { enabled: boolean; templates: string[]; imageIds: number[]; batchSeconds: number };
  private: { enabled: boolean; templates: string[]; imageIds: number[]; minDelayMin: number; maxDelayMin: number; perHour: number; perDay: number };
  quietStart: string;
  quietEnd: string;
  skipRejoinDays: number;
}
interface WelcomeRow {
  id: number;
  kind: "group" | "private";
  members: string;
  status: "pending" | "sent" | "skipped" | "failed";
  due_at: number;
  done_at: number | null;
  error: string;
}

// ---------- Định dạng ----------
const DAY = 86_400_000;
const num = (n: number) => n.toLocaleString("vi-VN");
const hm = new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit" });
const dm = new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit" });
const dmy = new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
/** "09:58 hôm nay", "Hôm qua 21:40", "09/11 14:20". */
function when(ts: number, now = Date.now()) {
  const d = new Date(ts);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return `${hm.format(d)} hôm nay`;
  if (d.toDateString() === new Date(now - DAY).toDateString()) return `Hôm qua ${hm.format(d)}`;
  if (d.toDateString() === new Date(now + DAY).toDateString()) return `${hm.format(d)} mai`;
  return `${dm.format(d)} ${hm.format(d)}`;
}
const initial = (name: string) => (name.trim().split(/\s+/).at(-1)?.[0] ?? "?").toLocaleUpperCase("vi");

function Net({ value }: { value: number }) {
  return <span className={`grp-net ${value > 0 ? "up" : value < 0 ? "down" : ""}`}>{`${value > 0 ? "+" : value < 0 ? "−" : ""}${num(Math.abs(value))}`}</span>;
}
const GroupAvatar = ({ size = 36 }: { size?: number }) => (
  <span className="avatar" style={{ width: size, height: size }}>
    <Users aria-hidden />
  </span>
);
function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className="switch" onClick={() => onChange(!on)}>
      <i />
    </button>
  );
}
function Seg<T extends string>({ items, value, onChange }: { items: [T, string][]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="grp-seg" role="tablist">
      {items.map(([k, l]) => (
        <button key={k} type="button" role="tab" aria-selected={k === value} onClick={() => onChange(k)}>
          {l}
        </button>
      ))}
    </div>
  );
}
function EmptyState({ icon, title, text, action, bad }: { icon: ReactNode; title: string; text: string; action?: ReactNode; bad?: boolean }) {
  return (
    <div className="card grp-empty">
      <span className={bad ? "ic bad" : "ic"}>{icon}</span>
      <div className="t">{title}</div>
      <p>{text}</p>
      {action}
    </div>
  );
}

// ---------- Trang ----------
export function GroupsPage({ account, onGoAccounts }: { account?: Account; onGoAccounts: () => void }) {
  const [groups, setGroups] = useState<GroupSummary[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  // ?nhom=<mã nhóm> mở thẳng trang của nhóm đó.
  const [openId, setOpenId] = useState<string | null>(() => new URLSearchParams(location.search).get("nhom"));
  const [scanning, setScanning] = useState(false);
  const connected = account?.state === "connected";

  const load = useCallback(() => {
    api<{ groups: GroupSummary[] }>("/api/groups")
      .then((r) => {
        setGroups(r.groups);
        setLoadError(false);
      })
      .catch(() => setLoadError(true));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const scanButton = (
    <button type="button" className="primary" onClick={() => (connected ? setScanning(true) : onGoAccounts())}>
      <ScanSearch aria-hidden />
      Quét nhóm
    </button>
  );
  const open = groups?.find((g) => g.id === openId);

  let body: ReactNode;
  if (!groups && !loadError) {
    body = <div className="grp-cards">{[0, 1, 2, 3].map((i) => <div key={i} className="card grp-stat"><span className="skel" style={{ height: 14, width: "50%" }} /><span className="skel" style={{ height: 28, width: "33%" }} /></div>)}</div>;
  } else if (loadError && !groups) {
    body = <EmptyState bad icon={<WifiOff aria-hidden />} title="Không tải được danh sách nhóm" text="Mất kết nối tới máy chạy trợ lý." action={<button type="button" onClick={load}>Thử lại</button>} />;
  } else if (groups!.length === 0) {
    body = connected ? (
      <EmptyState icon={<Users aria-hidden />} title="Chưa theo dõi nhóm nào" text="Bấm Quét nhóm để xem các nhóm nick trợ lý đang ở, rồi chọn nhóm muốn theo dõi. App bắt đầu đếm từ lúc chọn." action={scanButton} />
    ) : (
      <EmptyState bad icon={<WifiOff aria-hidden />} title="Zalo chưa kết nối" text="Cần kết nối nick Zalo để quét nhóm và ghi người vào, rời." action={<button type="button" className="primary" onClick={onGoAccounts}>Kết nối Zalo</button>} />
    );
  } else if (open) {
    body = <GroupDetail group={open} connected={connected} onBack={() => setOpenId(null)} onChanged={load} />;
  } else {
    body = (
      <>
        <div className="grp-head-row">
          <div className="grow">
            <h2>Nhóm đang theo dõi</h2>
            <p className="muted">Bấm một nhóm để xem thống kê và luồng chào mừng.</p>
          </div>
          {scanButton}
        </div>
        <div className="card grp-table-wrap">
          <table className="grp-table">
            <thead>
              <tr>
                <th>Nhóm</th>
                <th className="num">Thành viên</th>
                <th className="num hide-sm">Vào 7 ngày</th>
                <th className="num hide-sm">Rời 7 ngày</th>
                <th className="num">Tăng ròng</th>
                <th className="hide-md">Lời chào</th>
              </tr>
            </thead>
            <tbody>
              {groups!.map((g) => (
                <tr key={g.id} onClick={() => setOpenId(g.id)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setOpenId(g.id)}>
                  <td className="grp-name-cell">
                    <span className="grp-name">
                      <GroupAvatar size={32} />
                      <span className="t">{g.name}</span>
                    </span>
                  </td>
                  <td className="num">{num(g.memberCount)}</td>
                  <td className="num hide-sm">{g.joins7d}</td>
                  <td className="num hide-sm">{g.leaves7d}</td>
                  <td className="num">
                    <Net value={g.joins7d - g.leaves7d} />
                  </td>
                  <td className="hide-md">{g.welcomeOn ? <span className="badge task">Đang bật</span> : <span className="badge tag">Tắt</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  }

  return (
    <div className="grp-page">
      {body}
      {scanning && (
        <ScanDialog
          onClose={() => setScanning(false)}
          onTracked={() => {
            setScanning(false);
            load();
          }}
        />
      )}
    </div>
  );
}

// ---------- Hộp Quét nhóm ----------
function ScanDialog({ onClose, onTracked }: { onClose: () => void; onTracked: () => void }) {
  const [list, setList] = useState<ScanGroup[] | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ groups: ScanGroup[] }>("/api/groups/scan")
      .then((r) => setList(r.groups))
      .catch((err) => setError((err as Error).message));
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const shown = (list ?? []).filter((g) => g.name.toLocaleLowerCase("vi").includes(q.trim().toLocaleLowerCase("vi")));
  const track = async () => {
    setBusy(true);
    setError("");
    try {
      for (const id of picked) await api(`/api/groups/${encodeURIComponent(id)}/track`, { body: { on: true } });
      onTracked();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-body grp-scan" role="dialog" aria-label="Quét nhóm" onClick={(e) => e.stopPropagation()}>
        <div className="grp-scan-head">
          <div className="grow">
            <div className="grp-scan-title">Quét nhóm</div>
            <p className="muted">{list ? `Nick trợ lý đang ở ${list.length} nhóm. Tích nhóm muốn theo dõi.` : "Đang đọc danh sách nhóm từ Zalo…"}</p>
          </div>
          <button type="button" className="icon-only" aria-label="Đóng" onClick={onClose}>
            <X aria-hidden />
          </button>
        </div>
        <div className="grp-scan-search">
          <label className="ib-search">
            <Search aria-hidden />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm tên nhóm" aria-label="Tìm tên nhóm" />
          </label>
        </div>
        <ul className="grp-scan-list">
          {!list && !error && [0, 1, 2, 3].map((i) => <li key={i} className="grp-scan-item"><span className="skel" style={{ height: 14, width: "60%" }} /></li>)}
          {shown.map((g) => {
            const on = g.tracked || picked.has(g.id);
            return (
              <li key={g.id}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  disabled={g.tracked}
                  className="grp-scan-item"
                  onClick={() =>
                    setPicked((s) => {
                      const n = new Set(s);
                      if (n.has(g.id)) n.delete(g.id);
                      else n.add(g.id);
                      return n;
                    })
                  }
                >
                  <span className={on ? "grp-check on" : "grp-check"}>{on && <Check aria-hidden />}</span>
                  <span className="grow grp-scan-text">
                    <span className="n">{g.name}</span>
                    <span className="s">
                      {num(g.memberCount)} thành viên{g.isAdmin ? " · bạn là quản trị" : ""}
                      {g.tracked ? " · đang theo dõi" : ""}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {error && <div className="notice bad small grp-scan-error">{error}</div>}
        <div className="grp-scan-foot">
          <span className="grow small muted">Không có số liệu trước lúc theo dõi: Zalo không lưu lịch sử vào, rời.</span>
          <button type="button" className="ghost" onClick={onClose}>
            Huỷ
          </button>
          <button type="button" className="primary" disabled={!picked.size || busy} onClick={track}>
            {busy ? "Đang chụp danh sách…" : `Theo dõi ${picked.size} nhóm`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Trang một nhóm ----------
type Tab = "tk" | "tv" | "cm";
function GroupDetail({ group, connected, onBack, onChanged }: { group: GroupSummary; connected: boolean; onBack: () => void; onChanged: () => void }) {
  const [tab, setTab] = useState<Tab>(() => {
    const t = new URLSearchParams(location.search).get("tab");
    return t === "tv" || t === "cm" ? t : "tk";
  });
  const [days, setDays] = useState(30);
  const [bucket, setBucket] = useState<Bucket>("day");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [version, setVersion] = useState(0);
  const to = useMemo(() => Date.now(), [days, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const from = to - days * DAY;
  const base = `/api/groups/${encodeURIComponent(group.id)}`;

  const reconcile = async () => {
    setBusy(true);
    setMsg("");
    try {
      const r = await api<{ joined: number; left: number }>(`${base}/reconcile`, { method: "POST" });
      setMsg(r.joined || r.left ? `Đối chiếu xong: phát hiện ${r.joined} người vào, ${r.left} người rời lúc app tắt.` : "Đối chiếu xong: danh sách khớp, không có thay đổi.");
      setVersion((v) => v + 1);
      onChanged();
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const csv = `${base}/events.csv?from=${from}&to=${to}&account=${getCurrentAccount() ?? ""}`;

  return (
    <>
      <nav className="grp-crumb" aria-label="Đường dẫn">
        <button type="button" onClick={onBack}>
          Nhóm Zalo
        </button>
        <ChevronRight aria-hidden />
        <span className="cur">{group.name}</span>
      </nav>
      <div className="grp-title-row">
        <GroupAvatar size={40} />
        <div className="grow">
          <h2 className="grp-title">{group.name}</h2>
          <div className="muted">
            {`${num(group.memberCount)} thành viên · đếm từ ${dmy.format(group.trackedAt)}`}
          </div>
        </div>
        <div className="grp-title-actions">
          <button type="button" onClick={reconcile} disabled={busy || !connected} title={connected ? "So danh sách thành viên với Zalo ngay" : "Zalo chưa kết nối"}>
            <RefreshCw aria-hidden />
            {busy ? "Đang đối chiếu…" : "Đối chiếu ngay"}
          </button>
          <a className="btn-outline" href={csv} download>
            <Download aria-hidden />
            Xuất CSV
          </a>
        </div>
      </div>
      {msg && <div className="notice ok small">{msg}</div>}
      <div className="utabs" role="tablist">
        {(
          [
            ["tk", "Thống kê"],
            ["tv", "Thành viên"],
            ["cm", "Chào mừng"],
          ] as [Tab, string][]
        ).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      {tab === "tk" && <StatsTab base={base} group={group} from={from} to={to} days={days} setDays={setDays} bucket={bucket} setBucket={setBucket} version={version} />}
      {tab === "tv" && <MembersTab base={base} from={from} to={to} csv={csv} version={version} />}
      {tab === "cm" && <WelcomeTab base={base} onSaved={onChanged} />}
    </>
  );
}

// ---------- Tab Thống kê ----------
function StatsTab(p: { base: string; group: GroupSummary; from: number; to: number; days: number; setDays: (d: number) => void; bucket: Bucket; setBucket: (b: Bucket) => void; version: number }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [prev, setPrev] = useState<Stats | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setStats(null);
    const q = (f: number, t: number) => api<Stats>(`${p.base}/stats?from=${f}&to=${t}&bucket=${p.bucket}`);
    q(p.from, p.to)
      .then(setStats)
      .catch((err) => setError((err as Error).message));
    q(p.from - (p.to - p.from), p.from).then(setPrev).catch(() => setPrev(null));
  }, [p.base, p.from, p.to, p.bucket, p.version]);

  const periodLabel = `${p.days === 365 ? "12 tháng" : `${p.days} ngày`} qua`;
  const header = (
    <div className="grp-period">
      <div className="muted">{`${p.group.name} · ${periodLabel}`}</div>
      <div className="grp-period-tools">
        <Seg<Bucket>
          items={[
            ["day", "Ngày"],
            ["week", "Tuần"],
            ["month", "Tháng"],
          ]}
          value={p.bucket}
          onChange={p.setBucket}
        />
        <Popover
          align="end"
          trigger={({ toggle }) => (
            <button type="button" onClick={toggle}>
              <CalendarDays aria-hidden />
              {periodLabel}
            </button>
          )}
        >
          {(close) =>
            [7, 30, 90, 365].map((d) => (
              <button
                key={d}
                type="button"
                className="menu-item"
                role="menuitemradio"
                aria-checked={p.days === d}
                onClick={() => {
                  p.setDays(d);
                  close();
                }}
              >
                <span className="menu-text">{d === 365 ? "12 tháng qua" : `${d} ngày qua`}</span>
                {p.days === d && <Check className="check" aria-hidden />}
              </button>
            ))
          }
        </Popover>
      </div>
    </div>
  );
  if (error) return <EmptyState bad icon={<WifiOff aria-hidden />} title="Không tải được thống kê" text={error} />;
  if (!stats) {
    return (
      <div className="grp-stack">
        {header}
        <div className="grp-cards">{[0, 1, 2, 3].map((i) => <div key={i} className="card grp-stat"><span className="skel" style={{ height: 14, width: "50%" }} /><span className="skel" style={{ height: 28, width: "33%" }} /></div>)}</div>
      </div>
    );
  }
  const t = stats.totals;
  const diff = prev ? t.net - prev.totals.net : null;
  const cards: [string, ReactNode, string, string?][] = [
    ["Thành viên hiện tại", num(stats.currentMembers), stats.reconciledAt ? `Đối chiếu lúc ${when(stats.reconciledAt)}` : ""],
    ["Vào mới", num(t.joins), periodLabel],
    ["Rời nhóm", num(t.leaves), `${t.leaveBy.leave} tự rời · ${t.leaveBy.remove} bị mời ra · ${t.leaveBy.block} bị chặn`],
    ["Tăng ròng", `${t.net > 0 ? "+" : t.net < 0 ? "−" : ""}${num(Math.abs(t.net))}`, diff === null ? "" : `So với kỳ trước: ${diff > 0 ? "+" : diff < 0 ? "−" : "±"}${num(Math.abs(diff))}`, t.net > 0 ? "up" : t.net < 0 ? "down" : ""],
  ];
  const ret = (r: Retention | null, d: number): [string, string] => (r ? [`Sau ${d} ngày (${r.cohort} người)`, `${r.percent}%`] : [`Sau ${d} ngày`, "Chưa đủ dữ liệu"]);
  return (
    <div className="grp-stack">
      {header}
      <div className="grp-cards">
        {cards.map(([l, v, s, tone]) => (
          <div key={l} className="card grp-stat">
            <div className="l">{l}</div>
            <div className={`v ${tone ?? ""}`}>{v}</div>
            {s && <div className="s">{s}</div>}
          </div>
        ))}
      </div>
      <Chart series={stats.series} bucket={p.bucket} />
      <div className="grp-breakdown">
        <Breakdown
          title="Cách vào nhóm"
          rows={[
            ["Tự vào bằng link", t.joinBy.link],
            ["Được thành viên thêm", t.joinBy.added],
            ["Phát hiện khi đối chiếu", t.joinBy.diff],
          ]}
        />
        <Breakdown title="Ai thêm nhiều người nhất" rows={stats.topAdders.length ? stats.topAdders.map((a) => [a.name, a.count]) : [["Chưa có ai thêm người trong kỳ", ""]]} />
        <Breakdown title="Ở lại sau khi vào" rows={[ret(stats.retention.d7, 7), ret(stats.retention.d30, 30)]} />
      </div>
    </div>
  );
}

function Chart({ series, bucket }: { series: Stats["series"]; bucket: Bucket }) {
  const max = Math.max(1, ...series.map((s) => Math.max(s.joins, s.leaves)));
  const label = (k: string) => (bucket === "month" ? `${k.slice(5, 7)}/${k.slice(0, 4)}` : `${k.slice(8, 10)}/${k.slice(5, 7)}`);
  const ticks = series.length > 2 ? [series[0], series[Math.floor(series.length / 2)], series.at(-1)] : series;
  const unit = bucket === "day" ? "ngày" : bucket === "week" ? "tuần" : "tháng";
  return (
    <div className="card grp-chart">
      <div className="grp-chart-head">
        <div className="t">{`Vào và rời theo ${unit}`}</div>
        <div className="legend">
          <span>
            <i className="join" />
            Vào
          </span>
          <span>
            <i className="leave" />
            Rời
          </span>
        </div>
      </div>
      <div className="grp-bars" role="img" aria-label={`Biểu đồ vào và rời theo ${unit}`}>
        {series.map((s) => (
          <div key={s.key} className="grp-bar" title={`${label(s.key)}: vào ${s.joins}, rời ${s.leaves}`}>
            <span className="join" style={{ height: `${(s.joins / max) * 50}%` }} />
            <span className="leave" style={{ height: `${(s.leaves / max) * 50}%` }} />
          </div>
        ))}
      </div>
      <div className="grp-ticks">
        {ticks.map((s) => s && <span key={s.key}>{label(s.key)}</span>)}
      </div>
    </div>
  );
}

function Breakdown({ title, rows }: { title: string; rows: [string, ReactNode][] }) {
  return (
    <div className="card grp-break">
      <div className="t">{title}</div>
      <dl>
        {rows.map(([k, v], i) => (
          <div key={i} className="contents">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ---------- Tab Thành viên (vào / rời) ----------
const KIND = {
  join: { label: "Vào nhóm", icon: UserPlus, cls: "task" },
  leave: { label: "Tự rời", icon: LogOut, cls: "tag" },
  remove: { label: "Bị mời ra", icon: UserMinus, cls: "tag" },
  block: { label: "Bị chặn", icon: Ban, cls: "tag" },
} as const;
function viaText(e: GroupEvent) {
  if (e.kind === "join") {
    if (e.via === "added") return `${e.actor_name || "Một thành viên"} thêm vào`;
    if (e.via === "diff") return "Phát hiện khi đối chiếu (app tắt lúc vào)";
    return "Tự vào bằng link";
  }
  if (e.via === "diff") return "Phát hiện khi đối chiếu (app tắt lúc rời)";
  if (e.kind === "remove") return `Bị ${e.actor_name || "quản trị"} mời ra`;
  if (e.kind === "block") return "Bị chặn";
  return "Tự rời";
}
function MembersTab({ base, from, to, csv, version }: { base: string; from: number; to: number; csv: string; version: number }) {
  const [events, setEvents] = useState<GroupEvent[] | null>(null);
  const [filter, setFilter] = useState<"all" | "join" | "leave">("all");
  const [q, setQ] = useState("");
  useEffect(() => {
    setEvents(null);
    api<{ events: GroupEvent[] }>(`${base}/events?from=${from}&to=${to}&limit=2000`)
      .then((r) => setEvents(r.events))
      .catch(() => setEvents([]));
  }, [base, from, to, version]);
  const shown = (events ?? []).filter(
    (e) =>
      (filter === "all" || (filter === "join" ? e.kind === "join" : e.kind !== "join")) &&
      (e.user_name || e.user_id).toLocaleLowerCase("vi").includes(q.trim().toLocaleLowerCase("vi")),
  );
  return (
    <div className="card grp-events">
      <div className="grp-events-tools">
        <Seg<"all" | "join" | "leave">
          items={[
            ["all", "Tất cả"],
            ["join", "Vào"],
            ["leave", "Rời"],
          ]}
          value={filter}
          onChange={setFilter}
        />
        <label className="ib-search grow">
          <Search aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm tên thành viên" aria-label="Tìm tên thành viên" />
        </label>
        <a className="btn-outline" href={csv} download>
          <Download aria-hidden />
          Xuất CSV
        </a>
      </div>
      <ul className="grp-event-list">
        {!events &&
          [0, 1, 2, 3, 4].map((i) => (
            <li key={i} className="grp-event">
              <span className="skel avatar sm" />
              <span className="grow grp-event-main">
                <span className="skel" style={{ height: 14, width: "50%" }} />
                <span className="skel" style={{ height: 12, width: "33%" }} />
              </span>
            </li>
          ))}
        {events && shown.length === 0 && <li className="grp-events-empty muted">{events.length ? "Không có ai khớp bộ lọc." : "Chưa có ai vào hay rời trong kỳ này."}</li>}
        {shown.map((e) => {
          const k = KIND[e.kind];
          const Icon = k.icon;
          return (
            <li key={e.id} className="grp-event">
              <span className="avatar sm">{initial(e.user_name || "?")}</span>
              <div className="grow grp-event-main">
                <div className="grp-event-top">
                  <span className="n">{e.user_name || `Người dùng ${e.user_id.slice(-4)}`}</span>
                  <span className="time">{when(e.at)}</span>
                </div>
                <div className="grp-event-sub">
                  <span className={`badge ${k.cls}`}>
                    <Icon aria-hidden />
                    {k.label}
                  </span>
                  <span className="via">{viaText(e)}</span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------- Tab Chào mừng ----------
const VARS = ["{tên}", "{tên nhóm}", "{số thành viên}", "{người thêm}"];
// Mẫu hiển thị tiếng Việt có dấu; máy chủ dùng biến không dấu.
const toServer = (t: string) => t.replaceAll("{tên nhóm}", "{ten_nhom}").replaceAll("{số thành viên}", "{so_thanh_vien}").replaceAll("{người thêm}", "{nguoi_them}").replaceAll("{tên}", "{ten}");
const fromServer = (t: string) => t.replaceAll("{ten_nhom}", "{tên nhóm}").replaceAll("{so_thanh_vien}", "{số thành viên}").replaceAll("{nguoi_them}", "{người thêm}").replaceAll("{ten}", "{tên}");
const mapCfg = (c: WelcomeConfig, f: (t: string) => string): WelcomeConfig => ({
  ...c,
  group: { ...c.group, templates: c.group.templates.map(f) },
  private: { ...c.private, templates: c.private.templates.map(f) },
});

function Templates({ list, onChange }: { list: string[]; onChange: (l: string[]) => void }) {
  const [focus, setFocus] = useState(0);
  const insert = (v: string) => onChange(list.map((t, i) => (i === focus ? `${t}${t && !t.endsWith(" ") ? " " : ""}${v}` : t)));
  return (
    <div className="grp-field">
      {list.map((t, i) => (
        <div key={i} className="grp-template">
          <textarea rows={2} value={t} onFocus={() => setFocus(i)} onChange={(e) => onChange(list.map((x, j) => (j === i ? e.target.value : x)))} aria-label={`Mẫu tin ${i + 1}`} />
          {list.length > 1 && (
            <button type="button" className="icon-only" aria-label={`Xoá mẫu ${i + 1}`} onClick={() => onChange(list.filter((_, j) => j !== i))}>
              <X aria-hidden />
            </button>
          )}
        </div>
      ))}
      <div className="grp-template-tools">
        <div className="grp-chips">
          <span className="muted">Chèn:</span>
          {VARS.map((v) => (
            <button key={v} type="button" className="grp-chip" onClick={() => insert(v)}>
              {v}
            </button>
          ))}
        </div>
        {list.length < 5 && (
          <button type="button" className="ghost" onClick={() => onChange([...list, ""])}>
            <Plus aria-hidden />
            Thêm mẫu
          </button>
        )}
      </div>
    </div>
  );
}

function NumberBox({ value, onChange, min, max, width = 56, label }: { value: number; onChange: (v: number) => void; min: number; max: number; width?: number; label: string }) {
  return (
    <input
      className="grp-num"
      style={{ width }}
      inputMode="numeric"
      aria-label={label}
      value={value}
      onChange={(e) => {
        const n = Number(e.target.value.replace(/\D/g, ""));
        onChange(Math.min(max, Math.max(min, Number.isFinite(n) ? n : min)));
      }}
    />
  );
}

function Images({ ids, onChange }: { ids: number[]; onChange: (ids: number[]) => void }) {
  const [busy, setBusy] = useState(false);
  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      const out = [...ids];
      for (const f of [...files].slice(0, 10 - ids.length)) {
        const m = await api<{ id: number }>("/api/media", { body: { name: f.name, dataBase64: await readAsBase64(f) } });
        out.push(m.id);
      }
      onChange(out);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grp-field">
      <div className="grp-label">Ảnh kèm</div>
      <div className="grp-thumbs">
        {ids.map((id) => (
          <span key={id} className="grp-thumb">
            <img src={`/api/media/${id}`} alt="" />
            <button type="button" aria-label="Bỏ ảnh" onClick={() => onChange(ids.filter((x) => x !== id))}>
              <X aria-hidden />
            </button>
          </span>
        ))}
        {ids.length < 10 && (
          <label className="grp-thumb add" aria-label="Thêm ảnh" title="Thêm ảnh">
            <ImagePlus aria-hidden />
            <input type="file" accept="image/*" multiple hidden disabled={busy} onChange={(e) => void add(e.target.files)} />
          </label>
        )}
      </div>
    </div>
  );
}

const logStatus = (w: WelcomeRow, cfg: WelcomeConfig) => {
  if (w.status === "sent") return <span className="badge ok">Đã gửi</span>;
  if (w.status === "failed") return <span className="badge bad">Không gửi được</span>;
  if (w.status === "skipped") return <span className="badge tag">Bỏ qua</span>;
  const d = new Date(w.due_at);
  const m = d.getHours() * 60 + d.getMinutes();
  const qe = Number(cfg.quietEnd.slice(0, 2)) * 60 + Number(cfg.quietEnd.slice(3));
  return <span className="badge tag">{m === qe ? "Chờ hết giờ yên lặng" : "Đang chờ"}</span>;
};

function WelcomeTab({ base, onSaved }: { base: string; onSaved: () => void }) {
  const [saved, setSaved] = useState<WelcomeConfig | null>(null);
  const [cfg, setCfg] = useState<WelcomeConfig | null>(null);
  const [log, setLog] = useState<WelcomeRow[]>([]);
  const [preview, setPreview] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => {
    api<{ config: WelcomeConfig; log: WelcomeRow[] }>(`${base}/welcome`).then((r) => {
      const c = mapCfg(r.config, fromServer);
      setSaved(c);
      setCfg(c);
      setLog(r.log);
    });
  }, [base]);
  useEffect(() => load(), [load]);
  // Xem thử lời chào trong nhóm theo mẫu đang sửa (chưa cần lưu).
  useEffect(() => {
    if (!cfg) return;
    const t = setTimeout(() => {
      api<{ texts: string[] }>(`${base}/welcome/preview`, { body: { kind: "group", config: mapCfg(cfg, toServer) } })
        .then((r) => setPreview(r.texts))
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(t);
  }, [base, cfg]);

  if (!cfg || !saved) {
    return (
      <div className="grp-stack">
        {[0, 1].map((i) => (
          <div key={i} className="card grp-section">
            <span className="skel" style={{ height: 14, width: "40%" }} />
            <span className="skel" style={{ height: 48, width: "100%" }} />
          </div>
        ))}
      </div>
    );
  }
  const set = (patch: Partial<WelcomeConfig>) => setCfg({ ...cfg, ...patch });
  const setG = (patch: Partial<WelcomeConfig["group"]>) => setCfg({ ...cfg, group: { ...cfg.group, ...patch } });
  const setP = (patch: Partial<WelcomeConfig["private"]>) => setCfg({ ...cfg, private: { ...cfg.private, ...patch } });
  const dirty = JSON.stringify(cfg) !== JSON.stringify(saved);
  const save = async (next = cfg) => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await api<{ config: WelcomeConfig }>(base + "/welcome", { method: "PUT", body: mapCfg(next, toServer) });
      const c = mapCfg(r.config, fromServer);
      setSaved(c);
      setCfg(c);
      setNotice({ ok: true, text: "Đã lưu luồng chào mừng." });
      onSaved();
    } catch (err) {
      setNotice({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const today = new Date().toDateString();
  const sentToday = log.filter((w) => w.status === "sent" && w.done_at && new Date(w.done_at).toDateString() === today);
  const groupTpl = (i: number) => preview[i] ?? "";
  // Xem thử dùng tên mẫu cố định của máy chủ (Lan Anh, Minh Tuấn): tô đậm đúng hai tag đó.
  const highlighted = (text: string) => text.split(/(@Lan Anh|@Minh Tuấn)/g).map((p, i) => (p.startsWith("@") ? <b key={i}>{p}</b> : p));

  return (
    <div className="grp-stack">
      <div className="card grp-hero">
        <span className="grp-hero-ic">
          <HandHeart aria-hidden />
        </span>
        <div className="grow">
          <div className="t">{cfg.enabled ? "Luồng chào mừng đang bật" : "Luồng chào mừng đang tắt"}</div>
          <p className="muted">Chỉ chạy khi app đang chạy. Không chào chủ, phó nhóm và người vào lại trong {cfg.skipRejoinDays} ngày.</p>
        </div>
        <Switch on={cfg.enabled} label="Bật luồng chào mừng" onChange={(v) => void save({ ...cfg, enabled: v })} />
      </div>

      <div className="card grp-section">
        <div className="grp-section-head">
          <div className="grow">
            <div className="t">Chào trong nhóm</div>
            <p className="muted">Gom những người vào gần nhau thành một tin, tag tên từng người.</p>
          </div>
          <Switch on={cfg.group.enabled} label="Chào trong nhóm" onChange={(v) => setG({ enabled: v })} />
        </div>
        <div className="grp-label">Mẫu tin · app chọn ngẫu nhiên một mẫu</div>
        <Templates list={cfg.group.templates} onChange={(templates) => setG({ templates })} />
        <div className="grp-inline">
          Gom người vào trong
          <NumberBox value={Math.round(cfg.group.batchSeconds / 60)} min={0} max={30} label="Số phút gom" onChange={(v) => setG({ batchSeconds: v * 60 })} />
          phút thành một tin
        </div>
        {groupTpl(0) && (
          <div className="grp-field">
            <div className="grp-label">Xem thử</div>
            <div className="grp-preview">{highlighted(groupTpl(0))}</div>
          </div>
        )}
      </div>

      <div className="card grp-section">
        <div className="grp-section-head">
          <div className="grow">
            <div className="t">Chào riêng từng người</div>
            <p className="muted">Nhắn tin cá nhân cho người mới, có giới hạn để Zalo không khoá nick.</p>
          </div>
          <Switch on={cfg.private.enabled} label="Chào riêng từng người" onChange={(v) => setP({ enabled: v })} />
        </div>
        <div className="grp-label">Mẫu tin</div>
        <Templates list={cfg.private.templates} onChange={(templates) => setP({ templates })} />
        <Images ids={cfg.private.imageIds} onChange={(imageIds) => setP({ imageIds })} />
        <div className="grp-two">
          <div className="grp-inline">
            Gửi sau
            <NumberBox value={cfg.private.minDelayMin} min={0} max={120} label="Số phút chờ ít nhất" onChange={(v) => setP({ minDelayMin: v, maxDelayMin: Math.max(v, cfg.private.maxDelayMin) })} />–
            <NumberBox value={cfg.private.maxDelayMin} min={0} max={240} label="Số phút chờ nhiều nhất" onChange={(v) => setP({ maxDelayMin: v })} />
            phút
          </div>
          <div className="grp-inline">
            Tối đa
            <NumberBox value={cfg.private.perHour} min={1} max={60} label="Số tin mỗi giờ" onChange={(v) => setP({ perHour: v })} />
            tin/giờ,
            <NumberBox value={cfg.private.perDay} min={1} max={300} label="Số tin mỗi ngày" onChange={(v) => setP({ perDay: v })} />
            tin/ngày
          </div>
        </div>
        <div className="grp-warn">
          <TriangleAlert aria-hidden />
          <span>Người chặn tin từ người lạ sẽ không nhận được. Giữ giới hạn thấp: Zalo có thể hạn chế nick nhắn nhiều cho người chưa kết bạn.</span>
        </div>
      </div>

      <div className="card grp-section">
        <div className="t">Giờ yên lặng</div>
        <div className="grp-inline">
          Không gửi từ
          <input className="grp-num" style={{ width: 80 }} value={cfg.quietStart} onChange={(e) => set({ quietStart: e.target.value })} aria-label="Giờ bắt đầu yên lặng" placeholder="21:30" />
          đến
          <input className="grp-num" style={{ width: 80 }} value={cfg.quietEnd} onChange={(e) => set({ quietEnd: e.target.value })} aria-label="Giờ hết yên lặng" placeholder="07:30" />
          <span className="muted">· lời chào dồn sang sáng hôm sau</span>
        </div>
      </div>

      {notice && <div className={`notice small ${notice.ok ? "ok" : "bad"}`}>{notice.text}</div>}
      <div className="row">
        <button type="button" className="primary" disabled={!dirty || busy} onClick={() => void save()}>
          {busy ? "Đang lưu…" : "Lưu"}
        </button>
        <button type="button" className="ghost" disabled={!dirty || busy} onClick={() => setCfg(saved)}>
          Huỷ
        </button>
      </div>

      <div className="card grp-log">
        <div className="grp-log-head">
          <div className="t">Nhật ký gửi</div>
          <span className="small muted">
            Hôm nay: {sentToday.filter((w) => w.kind === "group").length} tin trong nhóm, {sentToday.filter((w) => w.kind === "private").length}/{cfg.private.perDay} tin riêng
          </span>
        </div>
        <ul>
          {log.length === 0 && <li className="grp-events-empty muted">Chưa gửi lời chào nào.</li>}
          {log.map((w) => {
            const members = JSON.parse(w.members) as { name: string }[];
            const who = w.kind === "group" ? members.map((m) => `@${m.name || "bạn mới"}`).join(", ") : members[0]?.name || "Người mới";
            return (
              <li key={w.id} className="grp-log-row">
                <span className="time">{w.status === "pending" ? `Chờ tới ${when(w.due_at)}` : when(w.done_at ?? w.due_at)}</span>
                <span className="kind">{w.kind === "group" ? "Trong nhóm" : "Riêng"}</span>
                <span className="who">{who}</span>
                {logStatus(w, cfg)}
                {w.error && <span className="note">{w.error}</span>}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
