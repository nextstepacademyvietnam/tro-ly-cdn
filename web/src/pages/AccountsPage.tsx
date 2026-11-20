import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { type Account, api } from "../api";
import { AdminZalo } from "../admin/AdminZalo";

type State = "logged_out" | "waiting_qr" | "scanned" | "connecting" | "connected" | "reconnecting" | "error";
interface Status {
  state: State;
  qrImage?: string;
  scannedName?: string;
  ownId?: string;
  ownName?: string;
  error?: string;
  hasSession: boolean;
}

function usePolling(fn: () => void, ms: number) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    ref.current();
    const t = setInterval(() => ref.current(), ms);
    return () => clearInterval(t);
  }, [ms]);
}

/** Cài đặt → Tài khoản Zalo: kết nối nick của tài khoản đang chọn (QR, nối lại, đăng xuất), đổi tên, xoá. */
export function AccountsPage({
  account,
  accounts,
  onAccountsChanged,
  onAddAccount,
}: {
  account?: Account;
  accounts: Account[];
  onAccountsChanged: () => Promise<void>;
  onAddAccount: () => Promise<void>;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  usePolling(() => {
    api<Status>("/api/zalo/status").then(setStatus).catch(() => undefined);
  }, status?.state === "waiting_qr" || status?.state === "scanned" ? 1500 : 4000);

  const act = async (path: string) => {
    setBusy(true);
    setError("");
    try {
      await api(path, { method: "POST" });
      setStatus(await api<Status>("/api/zalo/status"));
      await onAccountsChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rename = async () => {
    if (!account) return;
    const name = prompt("Tên tài khoản:", account.name);
    if (!name?.trim()) return;
    await api(`/api/accounts/${account.id}`, { method: "PUT", body: { name } });
    await onAccountsChanged();
  };
  const removeAccount = async () => {
    if (!account) return;
    if (!confirm(`Xoá tài khoản "${account.name}"? Trợ lý đăng xuất nick này và xoá hộp thư, tính cách, lịch gửi của nó. Không hoàn tác được.`)) return;
    try {
      await api(`/api/accounts/${account.id}`, { method: "DELETE" });
      await onAccountsChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!status) return <p className="muted">Đang tải…</p>;
  const connected = status.state === "connected" || status.state === "reconnecting";

  return (
    <section className="stack">
      <div className="card stack">
        <div className="row between">
          <StatusLine status={status} accountName={account?.name ?? ""} />
          <div className="row">
            <button type="button" className="link small" onClick={rename}>
              Đổi tên
            </button>
            {accounts.length > 1 && (
              <button type="button" className="link small danger" onClick={removeAccount}>
                Xoá tài khoản
              </button>
            )}
          </div>
        </div>
        {status.state === "waiting_qr" && status.qrImage && (
          <div className="qr">
            <img src={status.qrImage} alt="Mã QR đăng nhập Zalo" />
            <ol className="small">
              <li>Mở Zalo trên điện thoại của nick sẽ gắn vào tài khoản này.</li>
              <li>Bấm biểu tượng quét mã (góc trên bên phải) và quét mã này.</li>
              <li>Xác nhận đăng nhập trên điện thoại.</li>
            </ol>
          </div>
        )}
        {!connected && !status.hasSession && status.state === "logged_out" && !status.error && (
          <div className="notice warn">
            Tài khoản này chưa gắn nick Zalo nào. Bấm <b>Đăng nhập bằng mã QR</b> rồi quét bằng nick Zalo bạn muốn gắn vào đây
            (nick khác với các tài khoản đang có).
          </div>
        )}
        {status.error && <div className="notice bad">{status.error}</div>}
        {error && <div className="notice bad">{error}</div>}
        <div className="row">
          {!connected && status.state !== "waiting_qr" && status.state !== "scanned" && (
            <button type="button" className="primary" disabled={busy} onClick={() => act("/api/zalo/login")}>
              Đăng nhập bằng mã QR
            </button>
          )}
          {!connected && status.hasSession && (status.state === "error" || status.state === "logged_out") && (
            <button type="button" disabled={busy} onClick={() => act("/api/zalo/reconnect")}>
              Kết nối lại
            </button>
          )}
          {(connected || status.hasSession) && (
            <button
              type="button"
              className="link small danger"
              disabled={busy}
              onClick={() => confirm("Đăng xuất Zalo khỏi trợ lý? Lần sau phải quét QR lại.") && act("/api/zalo/logout")}
            >
              Đăng xuất Zalo
            </button>
          )}
        </div>
        {!connected && (
          <p className="muted small">
            Kết nối dùng giao thức Zalo Web không chính thức. Zalo có thể yêu cầu đăng nhập lại hoặc hạn chế tài khoản nếu nhắn
            quá nhiều. Mỗi nick chỉ gắn vào một tài khoản. Khi trợ lý đang chạy, đừng mở Zalo Web (chat.zalo.me) bằng cùng nick.
          </p>
        )}
      </div>
      {connected && <OwnerAlertsCard key={account?.id ?? 0} />}
      {connected && <SendLimitsCard key={`lim-${account?.id ?? 0}`} />}
      {connected && <AdminZalo key={`adm-${account?.id ?? 0}`} />}
      <div>
        <button type="button" onClick={() => onAddAccount().catch(() => undefined)}>
          <Plus aria-hidden />
          Thêm tài khoản Zalo
        </button>
      </div>
    </section>
  );
}

/** Báo về Zalo của chính bạn (khung "Cloud của tôi"): việc gấp. Tóm tắt định kỳ nằm ở thẻ Báo cáo định kỳ. */
function OwnerAlertsCard() {
  const [on, setOn] = useState<boolean | null>(null);

  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ enabled: boolean; preview: string }>("/api/owner-alerts")
      .then((r) => setOn(r.enabled))
      .catch(() => undefined);
  }, []);
  if (on === null) return null;
  const toggle = async () => {
    const r = await api<{ enabled: boolean }>("/api/owner-alerts", { method: "PUT", body: { enabled: !on } });
    setOn(r.enabled);
  };
  const test = async () => {
    setBusy(true);
    setMsg("");
    try {
      await api("/api/owner-alerts/test", { method: "POST" });
      setMsg('Đã gửi. Mở Zalo trên điện thoại, xem khung "Cloud của tôi".');
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card stack">
      <div className="row between">
        <div>
          <strong>Báo về Zalo của bạn</strong>
          <p className="muted small alert-intro">
            Trợ lý nhắn vào khung <b>Cloud của tôi</b> trên Zalo của nick này khi khách cần bạn trực tiếp, và khi nháp chờ duyệt quá 15 phút. Từ 21:30 tới 7:30 không nhắn, sáng gửi gộp. Tóm tắt định kỳ đặt ở thẻ Báo cáo định kỳ bên dưới.
          </p>
        </div>
        <button type="button" role="switch" aria-checked={on} aria-label="Báo về Zalo của bạn" className="switch" onClick={toggle}>
          <i />
        </button>
      </div>
      {on && (
        <div className="row">
          <button type="button" className="small-btn" disabled={busy} onClick={test}>
            {busy ? "Đang gửi…" : "Gửi thử"}
          </button>
          {msg && <span className="muted small">{msg}</span>}
        </div>
      )}
    </div>
  );
}

type LimitKey = "privateHour" | "privateDay" | "groupPerSenderHour" | "groupHour" | "groupDay" | "groupAutoHour";
type Limits = Record<LimitKey, number>;
const LIMIT_ROWS: { section: string; rows: [LimitKey, string][] }[] = [
  { section: "Chat riêng (mỗi khách)", rows: [["privateHour", "tin / 1 giờ"], ["privateDay", "tin / 24 giờ"]] },
  {
    section: "Nhóm",
    rows: [
      ["groupPerSenderHour", "tin trả lời mỗi người / 1 giờ"],
      ["groupHour", "tin cả nhóm / 1 giờ"],
      ["groupDay", "tin cả nhóm / 24 giờ"],
      ["groupAutoHour", "tin khi tự trả lời (không ai gọi) / 1 giờ"],
    ],
  },
];

/**
 * Giới hạn tin trợ lý tự gửi của nick này. Chạm giới hạn thì câu trả lời giữ ở dạng nháp chờ duyệt (không mất), báo bạn một lần.
 * Có mức mặc định; chỉnh theo nhu cầu, bấm "Về mặc định" để quay lại.
 */
function SendLimitsCard() {
  const [data, setData] = useState<{ limits: Limits; defaults: Limits; range: Record<LimitKey, [number, number]> } | null>(null);
  const [form, setForm] = useState<Record<LimitKey, string> | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const fill = (l: Limits) => setForm(Object.fromEntries(Object.entries(l).map(([k, v]) => [k, String(v)])) as Record<LimitKey, string>);
  useEffect(() => {
    api<{ limits: Limits; defaults: Limits; range: Record<LimitKey, [number, number]> }>("/api/zalo/limits")
      .then((r) => {
        setData(r);
        fill(r.limits);
      })
      .catch(() => undefined);
  }, []);
  if (!data || !form) return null;
  const changed = (Object.keys(form) as LimitKey[]).some((k) => Number(form[k]) !== data.limits[k]);
  const custom = (Object.keys(data.limits) as LimitKey[]).some((k) => data.limits[k] !== data.defaults[k]);
  const save = async (reset = false) => {
    setBusy(true);
    setMsg("");
    try {
      const body = reset ? { reset: true } : { limits: Object.fromEntries((Object.keys(form) as LimitKey[]).map((k) => [k, Number(form[k])])) };
      const r = await api<{ limits: Limits }>("/api/zalo/limits", { method: "PUT", body });
      setData({ ...data, limits: r.limits });
      fill(r.limits);
      setMsg(reset ? "Đã về mức mặc định." : "Đã lưu. Áp dụng ngay cho tin tiếp theo.");
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card stack">
      <div>
        <strong>Giới hạn tin trợ lý tự gửi</strong>
        <p className="muted small alert-intro">
          Chặn hai bot nhắn qua lại mãi và để nick không bị Zalo hạn chế. Chạm giới hạn thì câu trả lời được giữ ở dạng nháp chờ bạn duyệt, không mất.
        </p>
      </div>
      {LIMIT_ROWS.map((sec) => (
        <div key={sec.section} className="stack-sm">
          <span className="small"><b>{sec.section}</b></span>
          <div className="limit-grid">
            {sec.rows.map(([k, label]) => (
              <label key={k} className="limit-row">
                <input
                  type="number"
                  min={data.range[k][0]}
                  max={data.range[k][1]}
                  value={form[k]}
                  onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                />
                <span className="small">
                  {label} <span className="muted">(mặc định {data.defaults[k]})</span>
                </span>
              </label>
            ))}
          </div>
        </div>
      ))}
      <div className="row">
        <button type="button" className="small-btn primary" disabled={busy || !changed} onClick={() => save(false)}>
          Lưu
        </button>
        {custom && (
          <button type="button" className="link small" disabled={busy} onClick={() => save(true)}>
            Về mặc định
          </button>
        )}
        {msg && <span className="muted small">{msg}</span>}
      </div>
      <p className="muted small">Đặt quá cao dễ bị Zalo hạn chế nick; mỗi ô có giới hạn trên để tránh lỡ tay.</p>
    </div>
  );
}

function StatusLine({ status, accountName }: { status: Status; accountName: string }) {
  const text: Record<State, string> = {
    logged_out: "Chưa kết nối Zalo",
    waiting_qr: "Đang chờ quét mã QR…",
    scanned: `${status.scannedName ?? "Điện thoại"} đã quét — hãy xác nhận trên điện thoại`,
    connecting: "Đang kết nối…",
    connected: `Đã kết nối${status.ownName ? `: ${status.ownName}` : ""}`,
    reconnecting: "Mất mạng tạm thời, đang tự nối lại…",
    error: "Có lỗi",
  };
  const dot = status.state === "connected" ? "on" : status.state === "error" ? "bad" : status.state === "waiting_qr" || status.state === "scanned" ? "wait" : "off";
  return (
    <div className="row">
      <span className={`dot ${dot}`} />
      <strong>{accountName}</strong>
      <span className="muted">· {text[status.state]}</span>
    </div>
  );
}
