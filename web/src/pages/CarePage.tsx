import { useCallback, useEffect, useMemo, useState } from "react";
import { HeartHandshake, Lock } from "lucide-react";
import { type CarePlan, api } from "../api";
import { STATUS_LABEL, careDay } from "../care/CareSection";
import { Avatar } from "../ui";

type Filter = "today" | "upcoming" | "paused" | "stopped";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "today", label: "Hôm nay" },
  { key: "upcoming", label: "Sắp tới" },
  { key: "paused", label: "Tạm dừng" },
  { key: "stopped", label: "Đã dừng" },
];
const endOfToday = () => {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.getTime();
};

/**
 * Hộp thư → tab Chăm sóc (cột danh sách): mọi khách đang có kế hoạch chăm sóc chủ động, ai tới lượt hôm nay, ai sắp tới.
 * Bấm một khách là mở hội thoại ở cột giữa, như các tab khác của Hộp thư.
 */
export function CareList({ selected, onOpen }: { selected: string | null; onOpen: (threadId: string) => void }) {
  const [plans, setPlans] = useState<CarePlan[] | null>(null);
  const [filter, setFilter] = useState<Filter>("today");
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api<{ plans: CarePlan[] }>("/api/care")
      .then((r) => {
        setPlans(r.plans);
        setError("");
      })
      .catch((err) => setError((err as Error).message));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const groups = useMemo(() => {
    const end = endOfToday();
    const all = plans ?? [];
    return {
      today: all.filter((p) => p.status === "active" && p.nextAt !== null && p.nextAt < end),
      upcoming: all.filter((p) => p.status === "active" && p.nextAt !== null && p.nextAt >= end),
      paused: all.filter((p) => p.status === "paused"),
      stopped: all.filter((p) => p.status === "stopped"),
    } satisfies Record<Filter, CarePlan[]>;
  }, [plans]);
  const list = groups[filter];

  return (
    <>
      <div className="care-tools">
      <div className="ib-seg care-seg" role="tablist" aria-label="Lọc khách chăm sóc">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" role="tab" aria-selected={filter === f.key} onClick={() => setFilter(f.key)}>
            {f.label} <span className="num">{groups[f.key].length}</span>
          </button>
        ))}
      </div>
      <p className="info-hint">Tới lịch, trợ lý soạn sẵn tin vào tab Cần xử lý để bạn duyệt rồi gửi.</p>
      </div>
      {error && <div className="notice bad small ib-msg">{error}</div>}
      <div className="care-list">
        {plans === null ? (
          <p className="muted small care-empty">Đang tải…</p>
        ) : list.length === 0 ? (
          <div className="ib-empty">
            <span className="ic">
              <HeartHandshake aria-hidden />
            </span>
            <div className="t">{filter === "today" ? "Hôm nay chưa tới lượt khách nào" : "Không có khách nào ở mục này"}</div>
            {plans.length === 0 && (
              <p>Bật "Chăm sóc chủ động" trong trang Tính cách, rồi gắn nhãn tính cách đó cho khách. Trợ lý sẽ tự lập kế hoạch.</p>
            )}
          </div>
        ) : (
          <ul className="ib-rows care-rows">
            {list.map((p) => (
              <li key={p.threadId} className="ib-row" aria-current={p.threadId === selected ? "true" : undefined} onClick={() => onOpen(p.threadId)}>
                <Avatar name={p.name || "Khách"} />
                <div className="ib-row-main">
                  <div className="ib-row-top">
                    <span className="ib-row-name">{p.name || "Khách"}</span>
                    <span className="ib-row-time">
                      {p.status === "active" && p.nextAt ? careDay(p.nextAt) : STATUS_LABEL[p.status]}
                      {p.locked && <Lock className="care-lock" aria-label="Lịch do bạn khoá" />}
                    </span>
                  </div>
                  <div className="ib-row-last">{p.status === "stopped" && p.stopReason ? p.stopReason : p.goal || p.summary || "Chưa có tóm tắt"}</div>
                  <div className="ib-badges">
                    {p.stage && <span className="badge task">{p.stage}</span>}
                    {p.status === "active" && <span className="badge tag">mỗi {p.everyDays} ngày</span>}
                    {p.careCount > 0 && <span className="badge tag">đã chăm sóc {p.careCount} lần</span>}
                    {p.profileName && <span className="badge tag">🏷 {p.profileName}</span>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
