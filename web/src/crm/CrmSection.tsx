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
  phones: { phone: string; from: "crm" | "chu" | "zalo" | "chat" }[];
  matches: CrmMatch[];
  saved: { table: string; recordId: string; phone: string; at: number }[];
  leadDraft: { name: string; phone: string; note: string };
}

const when = (ms: number) => new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(ms);
/** Che bớt số: 0912•••678. */
const mask = (p: string) => (p.length >= 10 ? `${p.slice(0, 4)}•••${p.slice(-3)}` : p);
const SOURCE = { crm: " (số trong CRM, Zalo tìm ra đúng nick này)", chu: " (bạn nhập)", zalo: " (hồ sơ Zalo)", chat: " (khách gõ)" } as const;
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
          Tra theo {v.phones.map((p) => `${mask(p.phone)}${SOURCE[p.from]}`).join(", ")}
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
      <LeadSaver threadId={threadId} view={v} onSaved={setV} />
      {(error || v.error) && <div className="notice bad small">{error || `Lần đọc CRM gần nhất lỗi: ${v.error}`}</div>}
    </div>
  );
}

/** Lưu khách vào CRM: lần đầu tạo bản ghi, lần sau cập nhật đúng bản ghi đó. Bạn xem, sửa trước khi lưu. */
function LeadSaver({ threadId, view, onSaved }: { threadId: string; view: CrmView; onSaved: (v: CrmView) => void }) {
  const [open, setOpen] = useState(false);
  const [tables, setTables] = useState<{ name: string; label: string }[] | null>(null);
  const [form, setForm] = useState({ table: "", ...view.leadDraft });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const labelOf = (name: string) => tables?.find((t) => t.name === name)?.label ?? name;

  const start = async () => {
    setOpen(true);
    setError("");
    setMsg("");
    setForm((f) => ({ ...f, ...view.leadDraft, table: f.table }));
    try {
      const r = await api<{ tables: { name: string; label: string }[]; defaultTable: string }>("/api/crm-tables");
      setTables(r.tables);
      setForm((f) => ({ ...f, table: f.table || view.saved[0]?.table || r.defaultTable }));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api<CrmView & { created: boolean }>(`/api/crm/${encodeURIComponent(threadId)}/save`, { body: form });
      onSaved(r);
      setOpen(false);
      setMsg(r.created ? `Đã tạo bản ghi trong "${labelOf(form.table)}".` : `Đã cập nhật bản ghi trong "${labelOf(form.table)}".`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const updating = view.saved.some((s) => s.table === form.table);

  return (
    <div className="crm-save">
      {view.saved.length > 0 && !open && (
        <p className="info-hint">
          Đã lưu vào CRM{tables ? ` (${view.saved.map((s) => labelOf(s.table)).join(", ")})` : ""} lúc {when(view.saved[0]!.at)}.
        </p>
      )}
      {!open && (
        <button type="button" className="small-btn" onClick={start}>
          {view.saved.length ? "Cập nhật trong CRM" : view.matches.length ? "Lưu thêm vào CRM" : "Lưu vào CRM"}
        </button>
      )}
      {open && (
        <form className="crm-save-form" onSubmit={submit}>
          <label className="care-field">
            <span>Bảng</span>
            <select value={form.table} onChange={(e) => setForm({ ...form, table: e.target.value })} disabled={!tables}>
              {!tables && <option>Đang đọc danh sách bảng…</option>}
              {tables?.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="care-field">
            <span>Tên</span>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="care-field">
            <span>Số điện thoại</span>
            <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} inputMode="tel" placeholder="Chưa có" />
          </label>
          <label className="care-field">
            <span>Ghi chú (nhu cầu, đã trao đổi)</span>
            <textarea rows={5} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </label>
          <div className="crm-actions">
            <button type="submit" className="small-btn primary" disabled={busy || !tables || !form.table}>
              {busy ? "Đang lưu…" : updating ? "Cập nhật bản ghi" : "Tạo bản ghi"}
            </button>
            <button type="button" className="link small" onClick={() => setOpen(false)}>
              Huỷ
            </button>
          </div>
          {view.matches.length > 0 && !updating && <p className="info-hint">Số này đã có trong CRM ở trên; lưu nữa sẽ tạo thêm một bản ghi.</p>}
        </form>
      )}
      {msg && <p className="info-hint">{msg}</p>}
      {error && <div className="notice bad small">{error}</div>}
    </div>
  );
}
