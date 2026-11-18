import { type FormEvent, useCallback, useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { api } from "../api";

interface CrmMatch {
  table: string;
  kind: "lead" | "workshop";
  recordId: string;
  createdOn: string;
  name: string;
  status: string;
  fields: [string, string][];
  link: string;
}
interface CrmView {
  available: boolean;
  indexedAt: number;
  error: string;
  phones: { phone: string; from: "chu" | "zalo" | "chat" }[];
  matches: CrmMatch[];
}

const when = (ms: number) => new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(ms);
const day = (s: string) => (s ? s.slice(0, 10).split("-").reverse().join("/") : "");

/**
 * Mục "Khách trong CRM" ở cột thông tin Hộp thư: tra Pancake CRM theo số điện thoại khách gõ trong hội thoại
 * hoặc số bạn nhập. Chỉ hiện khi đã nối Pancake ở mục MKT. Trợ lý cũng đọc kết quả này khi trả lời.
 */
export function CrmSection({ threadId }: { threadId: string }) {
  const [v, setV] = useState<CrmView | null>(null);
  const [phone, setPhone] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const id = encodeURIComponent(threadId);

  const load = useCallback(() => {
    api<CrmView>(`/api/crm/${id}`)
      .then(setV)
      .catch(() => setV(null));
  }, [id]);
  useEffect(load, [load]);

  if (!v?.available) return null;

  const save = async (e?: FormEvent, value = phone) => {
    e?.preventDefault();
    setBusy("save");
    setError("");
    try {
      setV(await api<CrmView>(`/api/crm/${id}`, { method: "PUT", body: { phone: value } }));
      setEditing(false);
      setPhone("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  };
  const refresh = async () => {
    setBusy("refresh");
    setError("");
    try {
      await api("/api/crm/refresh", { method: "POST" });
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  };
  const linked = v.phones.find((p) => p.from === "chu");

  return (
    <div className="info-sec crm-sec">
      <div className="info-title">Khách trong CRM</div>
      {v.phones.length > 0 && (
        <p className="info-hint">
          Tra theo {v.phones.map((p) => `${p.phone}${p.from === "chu" ? " (bạn nhập)" : p.from === "zalo" ? " (hồ sơ Zalo)" : " (khách gõ)"}`).join(", ")}
        </p>
      )}
      {v.matches.map((m) => (
        <div key={`${m.table}-${m.recordId}`} className="crm-card">
          <div className="crm-head">
            <span className="crm-kind">{m.kind === "workshop" ? "Đăng ký workshop" : "Lead"}</span>
            {m.status && <span className="badge task">{m.status}</span>}
          </div>
          <div className="crm-name">
            {m.name || "(không tên)"}
            {m.createdOn && <span className="muted"> · {day(m.createdOn)}</span>}
          </div>
          {m.fields.length > 0 && (
            <dl className="care-dl">
              {m.fields.map(([k, val]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{val}</dd>
                </div>
              ))}
            </dl>
          )}
          {m.link && (
            <a className="link small crm-link" href={m.link} target="_blank" rel="noreferrer">
              Mở trong Pancake <ExternalLink aria-hidden />
            </a>
          )}
        </div>
      ))}
      {v.phones.length > 0 && v.matches.length === 0 && (
        <p className="small">Không thấy số này trong CRM{v.indexedAt ? ` (dữ liệu CRM lúc ${when(v.indexedAt)})` : ""}.</p>
      )}
      {v.phones.length === 0 && !editing && <p className="small muted">Khách chưa gõ số điện thoại. Nhập số để tra CRM.</p>}
      {(editing || v.phones.length === 0) && (
        <form className="crm-form" onSubmit={save}>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Số điện thoại khách" inputMode="tel" aria-label="Số điện thoại khách" />
          <button type="submit" className="small-btn" disabled={!phone.trim() || busy !== ""}>
            {busy === "save" ? "Đang tra…" : "Tra"}
          </button>
        </form>
      )}
      <div className="crm-actions">
        {v.phones.length > 0 && !editing && (
          <button type="button" className="link small" onClick={() => setEditing(true)}>
            Nhập số khác
          </button>
        )}
        {linked && (
          <button type="button" className="link small" disabled={busy !== ""} onClick={() => save(undefined, "")}>
            Bỏ số đã nhập
          </button>
        )}
        <button type="button" className="link small crm-refresh" disabled={busy !== ""} onClick={refresh} title="Đọc lại dữ liệu từ Pancake CRM">
          <RefreshCw aria-hidden />
          {busy === "refresh" ? "Đang đọc CRM (vài phút)…" : v.indexedAt ? `Đọc lại CRM` : "Đọc CRM lần đầu"}
        </button>
      </div>
      {(error || v.error) && <div className="notice bad small">{error || `Lần đọc CRM gần nhất lỗi: ${v.error}`}</div>}
    </div>
  );
}
