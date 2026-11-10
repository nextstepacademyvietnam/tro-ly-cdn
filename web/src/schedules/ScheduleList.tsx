import { useState } from "react";
import { api } from "../api";
import { ScheduleForm } from "./ScheduleForm";
import { RUN_LABEL, STATUS_LABEL, type Schedule, type ScheduleRun, fmtDateTime } from "./types";

/** Danh sách lịch, mỗi lịch có trạng thái, lượt kế tiếp, kết quả gửi và các nút thao tác. */
export function ScheduleList({
  schedules,
  onChanged,
  compact = false,
}: {
  schedules: Schedule[];
  onChanged: () => void;
  compact?: boolean;
}) {
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [runs, setRuns] = useState<ScheduleRun[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<{ id: number; text: string } | null>(null);

  const act = async (s: Schedule, path: string, opts: { method?: string; confirmText?: string } = {}) => {
    if (opts.confirmText && !confirm(opts.confirmText)) return;
    setBusy(s.id);
    setError(null);
    try {
      await api(path, { method: opts.method ?? "POST" });
      onChanged();
      if (open === s.id) loadRuns(s.id);
    } catch (err) {
      setError({ id: s.id, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const loadRuns = (id: number) => api<{ runs: ScheduleRun[] }>(`/api/schedules/${id}`).then((r) => setRuns(r.runs));
  const toggle = (id: number) => {
    if (open === id) return setOpen(null);
    setOpen(id);
    setRuns([]);
    loadRuns(id);
  };

  if (schedules.length === 0) return <p className="muted small">Chưa có lịch nào.</p>;

  return (
    <>
      <ul className="schedules">
        {schedules.map((s) => {
          const names = s.targets.map((t) => t.name || t.threadId);
          const targetName = (id: string) => s.targets.find((t) => t.threadId === id)?.name || id;
          return (
            <li key={s.id} className={`sched ${s.status}`}>
              <div className="row between">
                <span className={`status-pill ${s.status}`}>{STATUS_LABEL[s.status]}</span>
                {s.nextRunAt && s.status === "active" && <span className="small">⏰ {fmtDateTime(s.nextRunAt)}</span>}
                {s.nextRunAt && s.status === "paused" && <span className="small muted">Lượt kế: {fmtDateTime(s.nextRunAt)}</span>}
              </div>
              {s.title && <strong>{s.title}</strong>}
              <div className="small muted">{s.summary}</div>
              <div className="sched-text">
                {s.images.length > 0 && <span className="muted">🖼 {s.images.length} ảnh · </span>}
                {s.text || <em className="muted">(chỉ có ảnh)</em>}
              </div>
              {!compact || s.targets.length > 1 ? (
                <div className="small muted">
                  Gửi tới: {names.slice(0, 3).join(", ")}
                  {names.length > 3 && ` và ${names.length - 3} nơi khác`}
                </div>
              ) : null}
              <div className="small">
                {s.stats.sent > 0 && <span className="run-tag sent">Đã gửi {s.stats.sent}</span>}
                {s.stats.failed > 0 && <span className="run-tag failed">Lỗi {s.stats.failed}</span>}
                {s.stats.missed > 0 && <span className="run-tag missed">Lỡ giờ {s.stats.missed}</span>}
                {(s.stats.sent || s.stats.failed || s.stats.missed) > 0 && (
                  <button className="link small" onClick={() => toggle(s.id)}>
                    {open === s.id ? "Ẩn lịch sử" : "Lịch sử gửi"}
                  </button>
                )}
              </div>

              <div className="sched-actions">
                {s.status !== "cancelled" && (
                  <button className="link" onClick={() => setEditing(s)} disabled={busy === s.id}>
                    Sửa
                  </button>
                )}
                {s.status === "active" && (
                  <button className="link" onClick={() => act(s, `/api/schedules/${s.id}/pause`)} disabled={busy === s.id}>
                    Tạm dừng
                  </button>
                )}
                {s.status === "paused" && (
                  <button className="link" onClick={() => act(s, `/api/schedules/${s.id}/resume`)} disabled={busy === s.id}>
                    Chạy lại
                  </button>
                )}
                {s.status !== "cancelled" && (
                  <button
                    className="link"
                    onClick={() => act(s, `/api/schedules/${s.id}/send-now`, { confirmText: `Gửi ngay tới ${names.length} hội thoại? Lịch hẹn vẫn giữ nguyên.` })}
                    disabled={busy === s.id}
                  >
                    {busy === s.id ? "Đang gửi…" : "Gửi ngay"}
                  </button>
                )}
                <button className="link" onClick={() => act(s, `/api/schedules/${s.id}/duplicate`)} disabled={busy === s.id}>
                  Nhân bản
                </button>
                {(s.status === "active" || s.status === "paused") && (
                  <button
                    className="link danger"
                    onClick={() => act(s, `/api/schedules/${s.id}/cancel`, { confirmText: "Huỷ lịch này? Lịch sẽ dừng hẳn nhưng vẫn giữ trong lịch sử." })}
                    disabled={busy === s.id}
                  >
                    Huỷ
                  </button>
                )}
                <button
                  className="link danger"
                  onClick={() => act(s, `/api/schedules/${s.id}`, { method: "DELETE", confirmText: "Xoá hẳn lịch này và lịch sử gửi của nó?" })}
                  disabled={busy === s.id}
                >
                  Xoá
                </button>
              </div>
              {error?.id === s.id && <div className="notice bad small">{error.text}</div>}

              {open === s.id && (
                <ul className="runs">
                  {runs.length === 0 && <li className="muted small">Đang tải…</li>}
                  {runs.map((r) => (
                    <li key={r.id} className="small">
                      <span className={`run-tag ${r.status}`}>{RUN_LABEL[r.status]}</span> {targetName(r.threadId)} · {fmtDateTime(r.doneAt)}
                      {r.manual && <span className="muted"> · gửi tay</span>}
                      {r.error && <div className="muted">{r.error}</div>}
                      {r.status !== "sent" && (
                        <button className="link small" onClick={() => act(s, `/api/schedule-runs/${r.id}/retry`)} disabled={busy === s.id}>
                          Gửi lại
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {editing && (
        <ScheduleForm
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}
