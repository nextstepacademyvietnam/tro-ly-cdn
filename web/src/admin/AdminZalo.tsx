import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Plus, Search, Send, Trash2, X } from "lucide-react";
import { api } from "../api";

interface Admin {
  userId: string;
  name: string;
  addedAt: number;
}
interface Report {
  id: number;
  name: string;
  frequency: "daily" | "weekly";
  weekday: number;
  atMinute: number;
  recipients: string[];
  metrics: string[];
  enabled: boolean;
  schedule: string;
}
interface View {
  admins: Admin[];
  reports: Report[];
  metrics: { key: string; label: string }[];
  defaultMetrics: string[];
}
interface Conv {
  thread_id: string;
  thread_type: "user" | "group";
  name: string;
}

const WD = ["Chủ nhật", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy"];
const toTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const fromTime = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** Trang Tài khoản Zalo: admin ra lệnh qua Zalo + báo cáo định kỳ cho admin. */
export function AdminZalo() {
  const [v, setV] = useState<View | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<View>("/api/admin-zalo")
      .then(setV)
      .catch((err) => setError((err as Error).message));
  }, []);
  if (!v) return error ? <div className="notice bad small">{error}</div> : null;
  return (
    <>
      <AdminsCard v={v} onChange={setV} />
      <ReportsCard v={v} onChange={setV} />
    </>
  );
}

function AdminsCard({ v, onChange }: { v: View; onChange: (v: View) => void }) {
  const [picking, setPicking] = useState(false);
  const [convs, setConvs] = useState<Conv[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const open = async () => {
    setPicking(true);
    setError("");
    try {
      const r = await api<{ conversations: Conv[] }>("/api/zalo/conversations");
      setConvs(r.conversations.filter((c) => c.thread_type === "user"));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const shown = useMemo(() => {
    const s = q.trim().toLocaleLowerCase("vi");
    const taken = new Set(v.admins.map((a) => a.userId));
    return convs.filter((c) => !taken.has(c.thread_id) && (!s || (c.name || "").toLocaleLowerCase("vi").includes(s))).slice(0, 30);
  }, [convs, q, v.admins]);
  const add = async (userId: string) => {
    setError("");
    try {
      onChange(await api<View>("/api/admin-zalo/admins", { body: { userId } }));
      setPicking(false);
      setQ("");
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const remove = async (a: Admin) => {
    if (!confirm(`Bỏ quyền admin của ${a.name || "người này"}?`)) return;
    onChange(await api<View>(`/api/admin-zalo/admins/${encodeURIComponent(a.userId)}`, { method: "DELETE" }));
  };

  return (
    <div className="card stack">
      <div>
        <strong>Admin ra lệnh qua Zalo</strong>
        <p className="muted small alert-intro">
          Admin nhắn riêng cho nick này để cập nhật trợ lý mà không cần mở app: thêm khuyến mãi, lịch khai giảng, câu hỏi đáp; tạm dừng hoặc bật
          lại trợ lý, bật tắt chăm sóc; hỏi số liệu, tóm tắt một khách; gắn nhãn cho khách. Bot trả lời rõ đã làm gì, gõ <b>hoàn tác</b> để huỷ.
          Bot không gửi tin cho khách theo lệnh admin. Người không có trong danh sách gõ y hệt thì bot coi là khách.
        </p>
      </div>
      <ul className="adm-list">
        <li className="adm-row">
          <span className="adm-name">Chính nick này</span>
          <span className="muted small">nhắn trong "Cloud của tôi", mở đầu bằng "bot" hoặc "/" (VD: bot hôm nay thế nào)</span>
        </li>
        {v.admins.map((a) => (
          <li key={a.userId} className="adm-row">
            <span className="adm-name">{a.name || "(không tên)"}</span>
            <span className="muted small">nhắn riêng cho nick này, không cần tiền tố</span>
            <button type="button" className="icon-only push" onClick={() => remove(a)} aria-label={`Bỏ admin ${a.name}`} title="Bỏ quyền admin">
              <Trash2 aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      {!picking ? (
        <div>
          <button type="button" className="small-btn" onClick={open}>
            <Plus aria-hidden /> Thêm admin
          </button>
        </div>
      ) : (
        <div className="adm-pick">
          <div className="row">
            <label className="adm-search">
              <Search aria-hidden />
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm người trong Hộp thư (người đó phải từng nhắn nick này)" />
            </label>
            <button type="button" className="icon-only" onClick={() => setPicking(false)} aria-label="Đóng">
              <X aria-hidden />
            </button>
          </div>
          <ul className="adm-results">
            {shown.map((c) => (
              <li key={c.thread_id}>
                <button type="button" className="menu-item" onClick={() => add(c.thread_id)}>
                  {c.name || `Người dùng ${c.thread_id.slice(-4)}`}
                </button>
              </li>
            ))}
            {!shown.length && <li className="muted small">Không thấy ai. Nhờ người đó nhắn cho nick này một tin trước.</li>}
          </ul>
        </div>
      )}
      {error && <div className="notice bad small">{error}</div>}
    </div>
  );
}

type Draft = Omit<Report, "id" | "schedule">;

function ReportsCard({ v, onChange }: { v: View; onChange: (v: View) => void }) {
  const [editing, setEditing] = useState<{ id?: number; d: Draft } | null>(null);
  const [preview, setPreview] = useState<{ id: number; text: string } | null>(null);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const who = (r: string) => (r === "self" ? "Cloud của tôi" : v.admins.find((a) => a.userId === r)?.name || "admin đã bỏ");
  const blank: Draft = { name: "Báo cáo hằng ngày", frequency: "daily", weekday: 1, atMinute: 17 * 60 + 30, recipients: ["self"], metrics: v.defaultMetrics, enabled: true };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setError("");
    try {
      onChange(
        editing.id
          ? await api<View>(`/api/admin-zalo/reports/${editing.id}`, { method: "PUT", body: editing.d })
          : await api<View>("/api/admin-zalo/reports", { body: editing.d }),
      );
      setEditing(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const act = async (r: Report, kind: "send" | "preview" | "toggle" | "delete") => {
    setError("");
    setMsg("");
    try {
      if (kind === "preview") setPreview({ id: r.id, text: (await api<{ text: string }>(`/api/admin-zalo/reports/${r.id}/send`, { body: { preview: true } })).text });
      else if (kind === "send") {
        const x = await api<{ sent: number }>(`/api/admin-zalo/reports/${r.id}/send`, { body: {} });
        setMsg(`Đã gửi "${r.name}" tới ${x.sent} người nhận.`);
      } else if (kind === "toggle") onChange(await api<View>(`/api/admin-zalo/reports/${r.id}`, { method: "PUT", body: { enabled: !r.enabled } }));
      else if (confirm(`Xoá báo cáo "${r.name}"?`)) onChange(await api<View>(`/api/admin-zalo/reports/${r.id}`, { method: "DELETE" }));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const set = (patch: Partial<Draft>) => setEditing((x) => (x ? { ...x, d: { ...x.d, ...patch } } : x));
  const toggleIn = (list: string[], key: string) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);

  return (
    <div className="card stack">
      <div className="row between">
        <div>
          <strong>Báo cáo định kỳ</strong>
          <p className="muted small alert-intro">Bot gửi báo cáo qua Zalo cho bạn và admin theo lịch hằng ngày hoặc hằng tuần, gồm các chỉ số bạn chọn.</p>
        </div>
        {!editing && (
          <button type="button" className="small-btn" onClick={() => setEditing({ d: blank })}>
            <Plus aria-hidden /> Thêm báo cáo
          </button>
        )}
      </div>
      {v.reports.length === 0 && !editing && <p className="muted small">Chưa có báo cáo nào.</p>}
      {v.reports.length > 0 && (
        <ul className="rep-list">
          {v.reports.map((r) => (
            <li key={r.id} className="rep-row">
              <div className="rep-main">
                <div className="rep-name">
                  {r.name}
                  {!r.enabled && <span className="badge">Đang tắt</span>}
                </div>
                <div className="muted small">
                  {r.schedule} · gửi {r.recipients.map(who).join(", ")} · {r.metrics.length} chỉ số
                </div>
              </div>
              <div className="rep-actions">
                <button type="button" className="link small" onClick={() => act(r, "preview")}>
                  Xem trước
                </button>
                <button type="button" className="link small" onClick={() => act(r, "send")}>
                  <Send aria-hidden /> Gửi ngay
                </button>
                <button type="button" className="link small" onClick={() => setEditing({ id: r.id, d: { ...r } })}>
                  Sửa
                </button>
                <button type="button" role="switch" aria-checked={r.enabled} aria-label={`Bật báo cáo ${r.name}`} className="switch" onClick={() => act(r, "toggle")}>
                  <i />
                </button>
                <button type="button" className="icon-only" onClick={() => act(r, "delete")} aria-label={`Xoá ${r.name}`} title="Xoá">
                  <Trash2 aria-hidden />
                </button>
              </div>
              {preview?.id === r.id && <pre className="alert-preview rep-preview">{preview.text}</pre>}
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <form className="rep-form" onSubmit={save}>
          <label className="care-field">
            <span>Tên báo cáo</span>
            <input value={editing.d.name} onChange={(e) => set({ name: e.target.value })} />
          </label>
          <div className="rep-when">
            <label className="care-field">
              <span>Lịch</span>
              <select value={editing.d.frequency} onChange={(e) => set({ frequency: e.target.value as Draft["frequency"] })}>
                <option value="daily">Hằng ngày</option>
                <option value="weekly">Hằng tuần</option>
              </select>
            </label>
            {editing.d.frequency === "weekly" && (
              <label className="care-field">
                <span>Thứ</span>
                <select value={editing.d.weekday} onChange={(e) => set({ weekday: Number(e.target.value) })}>
                  {WD.map((w, i) => (
                    <option key={w} value={i}>
                      {w}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="care-field">
              <span>Giờ gửi</span>
              <input type="time" value={toTime(editing.d.atMinute)} onChange={(e) => set({ atMinute: fromTime(e.target.value) })} />
            </label>
          </div>
          <fieldset className="rep-group">
            <legend>Gửi cho</legend>
            {[{ key: "self", label: "Cloud của tôi (chính nick này)" }, ...v.admins.map((a) => ({ key: a.userId, label: a.name || "(không tên)" }))].map((o) => (
              <label key={o.key} className="rep-check">
                <input type="checkbox" checked={editing.d.recipients.includes(o.key)} onChange={() => set({ recipients: toggleIn(editing.d.recipients, o.key) })} />
                {o.label}
              </label>
            ))}
            {v.admins.length === 0 && <p className="muted small">Thêm admin ở thẻ trên để gửi báo cáo cho người khác.</p>}
          </fieldset>
          <fieldset className="rep-group">
            <legend>Chỉ số ({editing.d.frequency === "weekly" ? "7 ngày qua" : "24 giờ qua"})</legend>
            {v.metrics.map((m) => (
              <label key={m.key} className="rep-check">
                <input type="checkbox" checked={editing.d.metrics.includes(m.key)} onChange={() => set({ metrics: toggleIn(editing.d.metrics, m.key) })} />
                {m.label}
              </label>
            ))}
          </fieldset>
          <div className="row">
            <button type="submit" className="primary">
              {editing.id ? "Lưu" : "Tạo báo cáo"}
            </button>
            <button type="button" className="link small" onClick={() => setEditing(null)}>
              Huỷ
            </button>
          </div>
        </form>
      )}
      {msg && <p className="muted small">{msg}</p>}
      {error && <div className="notice bad small">{error}</div>}
    </div>
  );
}
