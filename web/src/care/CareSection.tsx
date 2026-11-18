import { useCallback, useEffect, useState } from "react";
import { CalendarClock, Lock, Pause, Pencil, Play, RefreshCw, Sparkles } from "lucide-react";
import { type CareLogEntry, type CarePlan, api } from "../api";
import { Popover } from "../ui";

interface CareView {
  plan: CarePlan | null;
  history: CareLogEntry[];
  careProfile: { id: number; name: string } | null;
  labelsKnown: boolean;
}

const WD = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
/** "T6, 20/11" theo giờ máy. */
export const careDay = (ms: number) => {
  const d = new Date(ms);
  return `${WD[d.getDay()]}, ${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const ymd = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const when = (ms: number) => new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(ms);
const LOG_LABEL: Record<CareLogEntry["kind"], string> = {
  analyze: "Lập kế hoạch",
  draft: "Soạn tin chăm sóc",
  sent: "Đã gửi",
  skip: "Bỏ qua",
  edit: "Chỉnh tay",
  stop: "Dừng",
  error: "Lỗi",
};
export const STATUS_LABEL: Record<CarePlan["status"], string> = { active: "Đang chăm sóc", paused: "Tạm dừng", stopped: "Đã dừng" };

/** Mục "Chăm sóc" ở cột thông tin Hộp thư: hồ sơ khách, đã trao đổi, kế hoạch chăm sóc tiếp theo. */
export function CareSection({ threadId }: { threadId: string }) {
  const [v, setV] = useState<CareView | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);

  const load = useCallback(() => {
    api<CareView>(`/api/care/${encodeURIComponent(threadId)}`)
      .then(setV)
      .catch(() => undefined);
  }, [threadId]);
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const save = async (body: Record<string, unknown>) => {
    setError("");
    try {
      await api(`/api/care/${encodeURIComponent(threadId)}`, { method: "PUT", body });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const analyze = async () => {
    setBusy("analyze");
    setError("");
    try {
      await api(`/api/care/${encodeURIComponent(threadId)}/analyze`, { method: "POST" });
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  };

  if (!v) return null;
  const p = v.plan;
  // Không áp dụng và chưa từng có kế hoạch: chỉ một dòng gợi ý.
  if (!p && !v.careProfile) {
    return v.labelsKnown ? (
      <div className="info-sec">
        <div className="info-title">Chăm sóc</div>
        <p className="info-hint">Gắn nhãn của một tính cách bật "Chăm sóc chủ động" để trợ lý lập hồ sơ và lịch chăm sóc khách này.</p>
      </div>
    ) : null;
  }

  return (
    <div className="info-sec care-sec">
      <div className="info-head">
        <div className="info-title">Chăm sóc{v.careProfile ? ` · ${v.careProfile.name}` : ""}</div>
        {p && <span className={`badge care-status ${p.status}`}>{STATUS_LABEL[p.status]}</span>}
      </div>

      {!p ? (
        <>
          <p className="info-hint">Trợ lý tự lập kế hoạch sau khi khách nhắn xong 30 phút. Muốn có ngay thì bấm bên dưới.</p>
          <div>
            <button type="button" className="small-btn" disabled={busy === "analyze"} onClick={() => void analyze()}>
              <Sparkles aria-hidden />
              {busy === "analyze" ? "Đang phân tích…" : "Lập kế hoạch ngay"}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="care-next">
            <CalendarClock aria-hidden />
            <div className="grow">
              {p.status === "active" && p.nextAt ? (
                <div className="care-next-t">
                  Lần tới <b>{careDay(p.nextAt)}</b> · mỗi {p.everyDays} ngày
                  {p.locked && <Lock className="care-lock" aria-label="Lịch do bạn khoá" />}
                </div>
              ) : (
                <div className="care-next-t">{p.status === "stopped" ? `Đã dừng${p.stopReason ? `: ${p.stopReason}` : ""}` : "Đang tạm dừng"}</div>
              )}
              {p.status === "active" && p.reason && <div className="care-why">{p.reason}</div>}
            </div>
          </div>
          {p.status === "active" && p.goal && (
            <div className="care-goal">
              <span className="care-k">Lần tới cần</span> {p.goal}
            </div>
          )}

          <div className="care-actions">
            <ScheduleMenu plan={p} onSave={save} />
            {p.status === "active" ? (
              <button type="button" className="small-btn" onClick={() => void save({ status: "paused" })}>
                <Pause aria-hidden />
                Tạm dừng
              </button>
            ) : (
              <button type="button" className="small-btn" onClick={() => void save({ status: "active" })}>
                <Play aria-hidden />
                Bật lại
              </button>
            )}
            <button type="button" className="small-btn care-reanalyze" disabled={busy === "analyze"} onClick={() => void analyze()} title="Đọc lại hội thoại, cập nhật hồ sơ và lịch">
              <RefreshCw aria-hidden className={busy === "analyze" ? "spin" : undefined} />
              {busy === "analyze" ? "Đang phân tích…" : "Phân tích lại"}
            </button>
          </div>

          {editing ? (
            <ProfileEditor plan={p} onCancel={() => setEditing(false)} onSave={async (b) => (await save(b), setEditing(false))} />
          ) : (
            <div className="care-profile">
              <div className="info-head">
                <span className="care-k">Hồ sơ khách</span>
                <button type="button" className="link small" onClick={() => setEditing(true)}>
                  <Pencil aria-hidden />
                  Sửa
                </button>
              </div>
              <dl className="care-dl">
                {p.stage && (
                  <>
                    <dt>Giai đoạn</dt>
                    <dd>
                      <span className="badge task">{p.stage}</span>
                    </dd>
                  </>
                )}
                <dt>Thông tin</dt>
                <dd className="care-pre">{p.facts || "—"}</dd>
                <dt>Đã trao đổi</dt>
                <dd>{p.summary || "—"}</dd>
                <dt>Nhu cầu</dt>
                <dd>{p.needs || "—"}</dd>
              </dl>
            </div>
          )}

          {v.history.length > 0 && (
            <details className="care-log">
              <summary>Lịch sử chăm sóc ({p.careCount} lần đã gửi)</summary>
              <ul>
                {v.history.slice(0, 8).map((h) => (
                  <li key={h.id}>
                    <span className="care-log-when">{when(h.at)}</span>
                    <span className={`care-log-kind ${h.kind}`}>{LOG_LABEL[h.kind]}</span>
                    <span className="care-log-text">{h.text}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {error && <div className="notice bad small">{error}</div>}
    </div>
  );
}

function ScheduleMenu({ plan, onSave }: { plan: CarePlan; onSave: (b: Record<string, unknown>) => Promise<void> }) {
  const [day, setDay] = useState(plan.nextAt ? ymd(plan.nextAt) : ymd(Date.now() + 86_400_000));
  const [every, setEvery] = useState(plan.everyDays);
  const [locked, setLocked] = useState(true);
  return (
    <Popover
      trigger={({ toggle }) => (
        <button type="button" className="small-btn" onClick={toggle}>
          <CalendarClock aria-hidden />
          Sửa lịch
        </button>
      )}
    >
      {(close) => (
        <div className="pop-body care-pop">
          <label className="care-field">
            <span>Lần chăm sóc tới</span>
            <input type="date" value={day} min={ymd(Date.now())} onChange={(e) => setDay(e.target.value)} />
          </label>
          <label className="care-field">
            <span>Sau đó cứ mấy ngày một lần</span>
            <input type="number" min={1} max={60} value={every} onChange={(e) => setEvery(Number(e.target.value))} />
          </label>
          <label className="check">
            <input type="checkbox" checked={locked} onChange={(e) => setLocked(e.target.checked)} />
            Giữ lịch này (AI không tự đổi)
          </label>
          <div className="row">
            <button
              type="button"
              className="primary small-btn"
              onClick={() => {
                close();
                void onSave({ nextDay: day, everyDays: every, locked, status: "active" });
              }}
            >
              Lưu lịch
            </button>
            {plan.locked && (
              <button
                type="button"
                className="ghost small-btn"
                onClick={() => {
                  close();
                  void onSave({ locked: false });
                }}
              >
                Để AI tự đặt lịch
              </button>
            )}
          </div>
        </div>
      )}
    </Popover>
  );
}

function ProfileEditor({ plan, onSave, onCancel }: { plan: CarePlan; onSave: (b: Record<string, unknown>) => Promise<void>; onCancel: () => void }) {
  const [f, setF] = useState({ stage: plan.stage, facts: plan.facts, summary: plan.summary, needs: plan.needs, goal: plan.goal });
  const field = (k: keyof typeof f, label: string, rows: number, hint?: string) => (
    <label className="care-field">
      <span>{label}</span>
      {rows === 1 ? (
        <input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
      ) : (
        <textarea rows={rows} value={f[k]} placeholder={hint} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
      )}
    </label>
  );
  return (
    <div className="care-edit">
      {field("stage", "Giai đoạn", 1)}
      {field("facts", "Thông tin khách", 4, "- Mỗi dòng một ý")}
      {field("summary", "Đã trao đổi", 3)}
      {field("needs", "Nhu cầu", 2)}
      {field("goal", "Lần chăm sóc tới cần", 2)}
      <div className="row">
        <button type="button" className="primary small-btn" onClick={() => void onSave(f)}>
          Lưu hồ sơ
        </button>
        <button type="button" className="ghost small-btn" onClick={onCancel}>
          Huỷ
        </button>
      </div>
    </div>
  );
}
