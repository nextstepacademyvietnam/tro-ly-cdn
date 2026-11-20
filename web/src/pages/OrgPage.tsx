import { type FormEvent, useEffect, useState } from "react";
import { Building2, RefreshCw } from "lucide-react";
import { api } from "../api";
import { timeAndDay } from "../ui";

interface OrgStatus {
  connected: boolean;
  orgName: string;
  role: string;
  email: string;
  displayName: string;
  lastSync: number;
  error: string;
  pendingEmail: string;
  pendingOrg: string;
}

const ROLE: Record<string, string> = { owner: "Chủ công ty", manager: "Quản lý", sales: "Nhân viên kinh doanh" };

/**
 * Cài đặt → Doanh nghiệp: nối app trên máy này với công ty (bản doanh nghiệp). Không nối thì là bản cá nhân như cũ.
 * Bước 1 dán mã kết nối quản lý gửi + email; bước 2 nhập mã xác nhận gửi về email.
 */
export function OrgPage() {
  const [s, setS] = useState<OrgStatus | null>(null);
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<OrgStatus>("/api/org")
      .then(setS)
      .catch((err) => setError((err as Error).message));
  }, []);

  const run = (fn: () => Promise<OrgStatus>) => async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError("");
    try {
      setS(await fn());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!s) return error ? <div className="notice bad">{error}</div> : null;

  return (
    <section className="stack">
      <div className="card stack">
        <div className="row org-head">
          <Building2 aria-hidden className="org-icon" />
          <div>
            <strong>Bản doanh nghiệp</strong>
            <p className="muted small alert-intro">
              Dùng cho phòng kinh doanh: mỗi người chạy app trên máy mình với nick Zalo của mình. Nối vào công ty thì quản lý thấy máy này và các nick Zalo
              đang chạy trên trang quản lý (kiến thức dùng chung, số liệu cả phòng, giao khách sẽ có ở bản sau). <b>Tin nhắn của khách vẫn chỉ nằm trên máy
              này.</b> Dùng một mình thì không cần nối.
            </p>
          </div>
        </div>

        {s.connected ? (
          <>
            <dl className="info-dl org-dl">
              <dt>Công ty</dt>
              <dd>{s.orgName}</dd>
              <dt>Bạn là</dt>
              <dd>
                {s.displayName || s.email} · {ROLE[s.role] ?? s.role}
              </dd>
              <dt>Email</dt>
              <dd>{s.email}</dd>
              <dt>Đồng bộ</dt>
              <dd>{s.lastSync ? `lần cuối ${timeAndDay(s.lastSync)}` : "chưa đồng bộ lần nào"}</dd>
            </dl>
            {s.error && <div className="notice bad small">{s.error}</div>}
            <div className="row">
              <button type="button" disabled={busy} onClick={run(() => api<OrgStatus>("/api/org/sync", { method: "POST" }))}>
                <RefreshCw aria-hidden /> Đồng bộ ngay
              </button>
              <button
                type="button"
                className="link small danger"
                disabled={busy}
                onClick={() => confirm("Ngắt kết nối với công ty? App trên máy quay về bản cá nhân, dữ liệu trên máy giữ nguyên.") && run(() => api<OrgStatus>("/api/org/disconnect", { method: "POST" }))()}
              >
                Ngắt kết nối
              </button>
            </div>
          </>
        ) : s.pendingEmail ? (
          <form className="stack org-form" onSubmit={run(() => api<OrgStatus>("/api/org/verify", { body: { token, displayName: name } }))}>
            <p className="small">
              Đã gửi mã xác nhận tới <b>{s.pendingEmail}</b> để vào <b>{s.pendingOrg || "công ty"}</b>. Mở email (xem cả mục Spam), nhập mã ở đây.
            </p>
            <label className="care-field">
              <span>Mã xác nhận</span>
              <input value={token} onChange={(e) => setToken(e.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="6 số trong email" autoFocus />
            </label>
            <label className="care-field">
              <span>Tên hiển thị trong công ty</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="VD: Hưng Sales" />
            </label>
            <div className="row">
              <button type="submit" className="primary" disabled={busy || !token.trim()}>
                {busy ? "Đang nối…" : "Vào công ty"}
              </button>
              <button type="button" className="link small" onClick={run(() => api<OrgStatus>("/api/org/cancel", { method: "POST" }))}>
                Làm lại
              </button>
            </div>
          </form>
        ) : (
          <form className="stack org-form" onSubmit={run(() => api<OrgStatus>("/api/org/start", { body: { code, email } }))}>
            <label className="care-field">
              <span>Mã kết nối (quản lý gửi cho bạn, bắt đầu bằng CDN1.)</span>
              <textarea rows={3} value={code} onChange={(e) => setCode(e.target.value)} placeholder="CDN1.…" spellCheck={false} />
            </label>
            <label className="care-field">
              <span>Email của bạn</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ten@congty.vn" autoComplete="email" />
            </label>
            <div className="row">
              <button type="submit" className="primary" disabled={busy || !code.trim() || !email.trim()}>
                {busy ? "Đang gửi…" : "Gửi mã xác nhận"}
              </button>
            </div>
          </form>
        )}
        {error && <div className="notice bad small">{error}</div>}
      </div>
    </section>
  );
}
