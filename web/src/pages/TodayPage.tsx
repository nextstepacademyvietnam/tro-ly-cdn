import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, CheckCheck, ChevronRight, Clock, Hand, HeartHandshake, PencilLine, WifiOff } from "lucide-react";
import { type Account, type BotState, type CarePlan, api } from "../api";
import type { Schedule } from "../schedules/types";
import { Avatar, waitLevel, waitText } from "../ui";

interface Conv {
  thread_id: string;
  thread_type: "user" | "group";
  name: string;
  last_text: string;
  last_message_at: number;
  pendingDrafts: number;
  draftSince: number;
  waitingHuman: boolean;
  handoff_reason: string;
  waitingReplySince: number;
  bot: BotState;
}
type Job = { c: Conv; kind: "human" | "draft" | "wait"; since: number };

const KIND: Record<Job["kind"], { icon: typeof Hand; label: string; action: string }> = {
  human: { icon: Hand, label: "Khách cần bạn trả lời trực tiếp", action: "Trả lời" },
  draft: { icon: PencilLine, label: "Nháp chờ bạn duyệt", action: "Duyệt" },
  wait: { icon: Clock, label: "Khách chờ, chưa ai trả lời", action: "Xử lý" },
};
const RANK: Record<Job["kind"], number> = { human: 0, draft: 1, wait: 2 };
const endOfToday = () => {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.getTime();
};
const hm = new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit" });
const nameOf = (c: Conv) => c.name || `${c.thread_type === "group" ? "Nhóm" : "Khách"} ${c.thread_id.slice(-4)}`;

/**
 * Hôm nay: màn mở app. Trên cùng là hàng việc cần bạn (xếp theo mức gấp rồi chờ lâu nhất trước), bấm là mở đúng hội thoại.
 * Cột phải: khách tới lượt chăm sóc và lịch gửi còn lại trong ngày. Dưới cùng là vài con số của nick đang chọn.
 */
export function TodayPage({
  account,
  onOpenThread,
  onGo,
}: {
  account?: Account;
  onOpenThread: (threadId: string, mode: "can" | "care") => void;
  onGo: (page: "hop" | "schedules" | "groups" | "settings" | "profiles") => void;
}) {
  const [convs, setConvs] = useState<Conv[] | null>(null);
  const [care, setCare] = useState<CarePlan[] | null>(null);
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(() => {
    api<{ conversations: Conv[] }>("/api/zalo/conversations")
      .then((r) => {
        setConvs(r.conversations);
        setError(false);
        setNow(Date.now());
      })
      .catch(() => setError(true));
    api<{ plans: CarePlan[] }>("/api/care")
      .then((r) => setCare(r.plans))
      .catch(() => setCare([]));
    api<{ schedules: Schedule[] }>("/api/schedules")
      .then((r) => setSchedules(r.schedules))
      .catch(() => setSchedules([]));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const jobs = useMemo<Job[]>(() => {
    const list: Job[] = [];
    for (const c of convs ?? []) {
      if (c.waitingHuman) list.push({ c, kind: "human", since: c.last_message_at });
      else if (c.pendingDrafts > 0) list.push({ c, kind: "draft", since: c.draftSince || c.last_message_at });
      else if (c.waitingReplySince > 0) list.push({ c, kind: "wait", since: c.waitingReplySince });
    }
    return list.sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.since - b.since);
  }, [convs]);

  const end = endOfToday();
  const careToday = (care ?? []).filter((p) => p.status === "active" && p.nextAt !== null && p.nextAt < end);
  const schedToday = (schedules ?? [])
    .filter((s) => s.status === "active" && s.nextRunAt !== null && s.nextRunAt < end)
    .sort((a, b) => a.nextRunAt! - b.nextRunAt!);
  const connected = account?.state === "connected";

  return (
    <div className="today">
      {!connected && account && (
        <div className="notice warn today-alert">
          <WifiOff aria-hidden />
          <span>Nick Zalo của tài khoản {account.name} chưa kết nối, trợ lý chưa nhận và gửi tin được.</span>
          <button type="button" className="small-btn" onClick={() => onGo("settings")}>
            Kết nối Zalo
          </button>
        </div>
      )}
      {connected && account?.paused && (
        <div className="notice warn today-alert">
          <span>Trợ lý đang tạm dừng: không trả lời ai cho tới khi bạn bấm nút trên đầu trang để chạy lại. Lịch gửi vẫn chạy.</span>
        </div>
      )}

      <div className="today-grid">
        <section className="card today-jobs" aria-labelledby="today-jobs-h">
          <div className="today-head">
            <h2 id="today-jobs-h">Việc cần bạn</h2>
            {jobs.length > 0 && <span className="today-count">{jobs.length}</span>}
            <button type="button" className="link small push" onClick={() => onGo("hop")}>
              Mở Hộp thư
            </button>
          </div>
          {convs === null && !error ? (
            <ul className="today-rows" aria-hidden>
              {[0, 1, 2].map((i) => (
                <li key={i} className="today-row">
                  <span className="skel avatar" />
                  <span className="today-row-main">
                    <span className="skel" style={{ height: 14, width: "50%" }} />
                    <span className="skel" style={{ height: 12, width: "80%" }} />
                  </span>
                </li>
              ))}
            </ul>
          ) : error && convs === null ? (
            <div className="ib-empty">
              <span className="ic bad">
                <WifiOff aria-hidden />
              </span>
              <div className="t">Không tải được việc hôm nay</div>
              <p>Mất kết nối tới máy chạy trợ lý.</p>
              <button type="button" onClick={load}>
                Thử lại
              </button>
            </div>
          ) : jobs.length === 0 ? (
            <div className="ib-empty">
              <span className="ic">
                <CheckCheck aria-hidden />
              </span>
              <div className="t">Không còn việc nào cần bạn</div>
              <p>Nháp chờ duyệt, khách cần người thật và khách chờ lâu sẽ hiện ở đây.</p>
            </div>
          ) : (
            <ul className="today-rows">
              {jobs.map(({ c, kind, since }) => {
                const k = KIND[kind];
                const waited = now - since;
                const level = kind === "human" ? "high" : waitLevel(waited);
                return (
                  <li key={c.thread_id}>
                    <button type="button" className="today-row" onClick={() => onOpenThread(c.thread_id, "can")}>
                      <Avatar name={nameOf(c)} group={c.thread_type === "group"} small />
                      <span className="today-row-main">
                        <span className="today-row-top">
                          <span className="n">{nameOf(c)}</span>
                          <span className="badge" data-level={level || undefined}>
                            <k.icon aria-hidden />
                            {waitText(waited)}
                          </span>
                        </span>
                        <span className="today-row-sub">
                          {k.label}
                          {kind === "human" && c.handoff_reason ? `: ${c.handoff_reason}` : c.last_text ? ` · ${c.last_text}` : ""}
                        </span>
                      </span>
                      <span className="today-go">
                        {k.action}
                        <ChevronRight aria-hidden />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <div className="today-side">
          <section className="card today-mini" aria-labelledby="today-care-h">
            <div className="today-head">
              <HeartHandshake aria-hidden />
              <h2 id="today-care-h">Chăm sóc hôm nay</h2>
              {careToday.length > 0 && <span className="today-count">{careToday.length}</span>}
            </div>
            {care === null ? (
              <p className="muted small">Đang tải…</p>
            ) : careToday.length === 0 ? (
              <p className="muted small">Hôm nay chưa tới lượt khách nào. Tới lượt, trợ lý soạn sẵn tin để bạn duyệt.</p>
            ) : (
              <ul className="today-list">
                {careToday.slice(0, 6).map((p) => (
                  <li key={p.threadId}>
                    <button type="button" className="today-item" onClick={() => onOpenThread(p.threadId, "care")}>
                      <span className="n">{p.name || "Khách"}</span>
                      <span className="s">{p.goal || p.summary || p.stage || "Chưa có tóm tắt"}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {careToday.length > 6 && <span className="muted small">Còn {careToday.length - 6} khách nữa trong Hộp thư → Chăm sóc.</span>}
          </section>

          <section className="card today-mini" aria-labelledby="today-sched-h">
            <div className="today-head">
              <CalendarClock aria-hidden />
              <h2 id="today-sched-h">Lịch gửi còn lại hôm nay</h2>
            </div>
            {schedules === null ? (
              <p className="muted small">Đang tải…</p>
            ) : schedToday.length === 0 ? (
              <p className="muted small">Không còn tin hẹn giờ nào trong hôm nay.</p>
            ) : (
              <ul className="today-list">
                {schedToday.slice(0, 6).map((s) => (
                  <li key={s.id}>
                    <button type="button" className="today-item sched" onClick={() => onGo("schedules")}>
                      <span className="t">{hm.format(s.nextRunAt!)}</span>
                      <span className="today-item-main">
                        <span className="n">{s.title || s.summary || "Lịch gửi"}</span>
                        <span className="s">
                          {s.targets.length} nơi nhận{s.aiMode === "draft" ? " · AI soạn, chờ duyệt" : s.aiMode === "auto" ? " · AI soạn, tự gửi" : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button type="button" className="link small" onClick={() => onGo("schedules")}>
              Xem mọi lịch gửi
            </button>
          </section>
        </div>
      </div>

      {account && (
        <div className="today-stats">
          <Stat label="Hội thoại chưa đọc" value={account.unreadConversations} onClick={() => onGo("hop")} />
          <Stat label="Lịch gửi đang chạy" value={account.activeSchedules} onClick={() => onGo("schedules")} />
          <Stat label="Nhóm đang theo dõi" value={account.trackedGroups} onClick={() => onGo("groups")} />
          <Stat label="Thông báo chưa đọc" value={account.unread} />
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, onClick }: { label: string; value: number; onClick?: () => void }) {
  const inner = (
    <>
      <span className="l">{label}</span>
      <span className="v">{value}</span>
    </>
  );
  return onClick ? (
    <button type="button" className="card today-stat" onClick={onClick}>
      {inner}
    </button>
  ) : (
    <div className="card today-stat">{inner}</div>
  );
}
