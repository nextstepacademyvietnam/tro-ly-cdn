import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { ScheduleForm } from "./ScheduleForm";
import { ScheduleList } from "./ScheduleList";
import { STATUS_LABEL, type Schedule, type ScheduleStatus, type Target } from "./types";

function useSchedules(query: string) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const load = useCallback(() => {
    api<{ schedules: Schedule[] }>(`/api/schedules${query}`)
      .then((r) => setSchedules(r.schedules))
      .catch(() => undefined);
  }, [query]);
  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);
  return { schedules, load };
}

/** Cột bên phải khung chat: lịch của đúng hội thoại này. */
export function ScheduleSidebar({ target }: { target: Target }) {
  const { schedules, load } = useSchedules(`?thread=${encodeURIComponent(target.threadId)}`);
  const [creating, setCreating] = useState(false);
  const active = schedules.filter((s) => s.status === "active" || s.status === "paused");
  const old = schedules.filter((s) => s.status === "done" || s.status === "cancelled");
  const [showOld, setShowOld] = useState(false);

  return (
    <div className="info-sec">
      <div className="info-head">
        <div className="info-title">Lịch gửi của hội thoại</div>
        <button type="button" className="link" onClick={() => setCreating(true)}>
          + Lên lịch
        </button>
      </div>
      <ScheduleList schedules={active} onChanged={load} compact />
      {old.length > 0 && (
        <>
          <button className="link small" onClick={() => setShowOld((v) => !v)}>
            {showOld ? "Ẩn" : "Xem"} lịch đã xong / đã huỷ ({old.length})
          </button>
          {showOld && <ScheduleList schedules={old} onChanged={load} compact />}
        </>
      )}
      {creating && (
        <ScheduleForm
          defaultTarget={target}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            load();
          }}
        />
      )}
    </div>
  );
}

/** Trang tổng hợp mọi lịch. */
export function SchedulesPage() {
  const [status, setStatus] = useState<ScheduleStatus | "">("");
  const { schedules, load } = useSchedules(status ? `?status=${status}` : "");
  const [creating, setCreating] = useState(false);

  return (
    <section className="stack">
      <div className="row between">
        <div className="seg">
        <button className={status === "" ? "active" : ""} onClick={() => setStatus("")}>
          Tất cả
        </button>
        {(Object.keys(STATUS_LABEL) as ScheduleStatus[]).map((s) => (
          <button key={s} className={status === s ? "active" : ""} onClick={() => setStatus(s)}>
            {STATUS_LABEL[s]}
          </button>
        ))}
        </div>
        <button type="button" className="primary" onClick={() => setCreating(true)}>
          + Lên lịch
        </button>
      </div>
      <ScheduleList schedules={schedules} onChanged={load} />
      {creating && (
        <ScheduleForm
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            load();
          }}
        />
      )}
    </section>
  );
}
