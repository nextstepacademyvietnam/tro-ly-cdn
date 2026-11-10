import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  CheckCheck,
  ChevronDown,
  Hand,
  Info,
  ListFilter,
  PencilLine,
  Search,
  Tag,
  WifiOff,
  X,
} from "lucide-react";
import { type Account, type BotState, type Draft, type Profile, api } from "../api";
import { ScheduleForm } from "../schedules/ScheduleForm";
import { ScheduleSidebar } from "../schedules/SchedulePanels";
import { Avatar, Popover, fullDate, shortTime, timeAndDay, waitLevel, waitText } from "../ui";

interface Conversation {
  thread_id: string;
  thread_type: "user" | "group";
  name: string;
  last_text: string;
  last_message_at: number;
  unread: number;
  bot: BotState;
  pendingDrafts: number;
  draftSince: number;
  firstMessageAt: number;
  waitingHuman: boolean;
  handoff_reason: string;
  handoff_until: number;
  no_proactive: number;
}
interface Message {
  id: number;
  direction: "in" | "out";
  source: "zalo" | "owner" | "ai";
  sender_name: string;
  text: string | null;
  kind: string;
  created_at: number;
}
type LabelValue = number | "off" | null;
type BotFilter = "all" | "none" | "off" | number;

function usePolling(fn: () => void, ms: number) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    ref.current();
    const t = setInterval(() => ref.current(), ms);
    return () => clearInterval(t);
  }, [ms]);
}

/** Tin không phải chữ: đổi mã loại của Zalo sang chữ dễ đọc. */
const KIND_LABEL: Record<string, string> = {
  "chat.photo": "Ảnh",
  "chat.video.msg": "Video",
  "chat.sticker": "Nhãn dán",
  "chat.voice": "Tin nhắn thoại",
  "chat.gif": "Ảnh động",
  "share.file": "Tệp",
  "chat.recommended": "Danh thiếp / liên kết",
  "chat.link": "Liên kết",
  "chat.location.new": "Vị trí",
};
const kindText = (kind: string) => `[${KIND_LABEL[kind] ?? "Tin đặc biệt"}]`;

const needsAction = (c: Conversation) => c.pendingDrafts > 0 || c.waitingHuman;
const displayName = (c: Conversation) => c.name || `${c.thread_type === "group" ? "Nhóm" : "Người dùng"} ${c.thread_id.slice(-4)}`;

/** Huy hiệu việc: nháp chờ duyệt hoặc chờ người thật, kèm đã chờ bao lâu. */
function TaskBadge({ c, now }: { c: Conversation; now: number }) {
  if (c.waitingHuman) {
    return (
      <span className="badge" data-level="high">
        <Hand aria-hidden />
        Chờ người thật · {waitText(now - c.last_message_at)}
      </span>
    );
  }
  if (c.pendingDrafts > 0) {
    const waited = now - (c.draftSince || c.last_message_at);
    const level = waitLevel(waited);
    return (
      <span className={level ? "badge" : "badge task"} data-level={level || undefined}>
        <PencilLine aria-hidden />
        Nháp chờ duyệt · {waitText(waited)}
      </span>
    );
  }
  return null;
}

function TagBadge({ bot, profiles, offTag }: { bot: BotState; profiles: Profile[]; offTag: string }) {
  if (bot.kind === "none") return null;
  if (bot.kind === "off") return <span className="badge tag" title="Nhãn Zalo tắt bot"><span className="bt">🚫 {offTag}</span></span>;
  const p = profiles.find((x) => x.id === bot.profileId);
  return (
    <span className="badge tag" title={bot.conflict.length ? `Còn nhãn: ${bot.conflict.join(", ")} — nên gỡ bớt` : `Tính cách: ${bot.name}`}>
      <span className="bt">
        🏷 {p?.tag || bot.name}
        {bot.conflict.length > 0 && " ⚠"}
      </span>
    </span>
  );
}

export function InboxPage({
  account,
  mode,
  onModeChange,
  onGoAccounts,
}: {
  account?: Account;
  mode: "can" | "all";
  onModeChange: (m: "can" | "all") => void;
  onGoAccounts: () => void;
}) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [labelsAvailable, setLabelsAvailable] = useState(true);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [showUser, setShowUser] = useState(true);
  const [showGroup, setShowGroup] = useState(true);
  const [botFilter, setBotFilter] = useState<BotFilter>("all");
  const [search, setSearch] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [bulkSchedule, setBulkSchedule] = useState(false);
  const [notice, setNotice] = useState("");
  const [assignError, setAssignError] = useState("");
  const [infoOpen, setInfoOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const offTag = account?.offTag || "Không bot";
  const canSend = account?.state === "connected";

  const load = useCallback(() => {
    api<{ conversations: Conversation[]; labelsAvailable: boolean }>("/api/zalo/conversations")
      .then((r) => {
        setConversations(r.conversations);
        setLabelsAvailable(r.labelsAvailable);
        setLoaded(true);
        setLoadError(false);
        setNow(Date.now());
      })
      .catch(() => setLoadError(true));
  }, []);
  usePolling(load, 4000);
  useEffect(() => {
    api<{ profiles: Profile[] }>("/api/profiles")
      .then((r) => setProfiles(r.profiles))
      .catch(() => undefined);
  }, []);

  const visible = useMemo(() => {
    const q = search.trim().toLocaleLowerCase("vi");
    return conversations.filter((c) => {
      if (mode === "can" && !needsAction(c)) return false;
      if (c.thread_type === "user" && !showUser) return false;
      if (c.thread_type === "group" && !showGroup) return false;
      if (q && !displayName(c).toLocaleLowerCase("vi").includes(q)) return false;
      if (botFilter === "none") return c.bot.kind === "none";
      if (botFilter === "off") return c.bot.kind === "off";
      if (typeof botFilter === "number") return c.bot.kind === "profile" && c.bot.profileId === botFilter;
      return true;
    });
  }, [conversations, mode, showUser, showGroup, botFilter, search]);
  const actionCount = conversations.filter(needsAction).length;

  // Màn rộng: mở sẵn hội thoại đầu danh sách, như wireframe.
  useEffect(() => {
    const shown = selected && visible.some((c) => c.thread_id === selected);
    if (!shown && visible.length && window.matchMedia("(min-width: 1024px)").matches) setSelected(visible[0]!.thread_id);
  }, [selected, visible]);

  const toggle = (id: string) =>
    setChecked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const assign = async (ids: string[], value: LabelValue) => {
    if (!ids.length) return;
    setAssignError("");
    setNotice("Đang ghi nhãn lên Zalo…");
    try {
      const r = await api<{ count: number; failed: string[]; created: string[] }>("/api/zalo/conversations/assign", {
        body: { threadIds: ids, value },
      });
      const what =
        value === null ? "gỡ nhãn trợ lý" : value === "off" ? `gắn nhãn ${offTag}` : `gắn nhãn "${profiles.find((p) => p.id === value)?.tag}"`;
      setNotice(
        `Đã ${what} cho ${r.count} hội thoại trên Zalo.` +
          (r.created.length ? ` Đã tạo nhãn mới trong Zalo: ${r.created.join(", ")}.` : "") +
          (r.failed.length ? ` Lỗi: ${r.failed.join("; ")}` : ""),
      );
      load();
    } catch (err) {
      setNotice("");
      setAssignError((err as Error).message);
    }
  };

  const current = visible.find((c) => c.thread_id === selected);
  const checkedList = conversations.filter((c) => checked.has(c.thread_id));
  const filterCount = (showUser && showGroup ? 0 : 1) + (botFilter === "all" ? 0 : 1);

  let body: React.ReactNode;
  if (!loaded && !loadError) {
    body = Array.from({ length: 6 }, (_, i) => (
      <li key={i} className="ib-row" aria-hidden>
        <span className="skel avatar" />
        <span className="ib-row-main">
          <span className="skel" style={{ height: 14, width: "66%" }} />
          <span className="skel" style={{ height: 12, width: "92%" }} />
        </span>
      </li>
    ));
  } else if (loadError && !loaded) {
    body = (
      <li className="ib-empty">
        <span className="ic bad">
          <WifiOff aria-hidden />
        </span>
        <div className="t">Không tải được hộp thư</div>
        <p>Mất kết nối tới máy chạy trợ lý.</p>
        <button type="button" onClick={load}>
          Thử lại
        </button>
      </li>
    );
  } else if (conversations.length === 0) {
    body = (
      <li className="ib-empty">
        <div className="t">Chưa có tin nhắn nào</div>
        <p>Kết nối Zalo xong, hội thoại mới sẽ hiện ở đây.</p>
        {!canSend && (
          <button type="button" className="primary" onClick={onGoAccounts}>
            Kết nối Zalo
          </button>
        )}
      </li>
    );
  } else if (visible.length === 0 && mode === "can" && !search && filterCount === 0) {
    body = (
      <li className="ib-empty">
        <span className="ic">
          <CheckCheck aria-hidden />
        </span>
        <div className="t">Không còn việc nào cần bạn</div>
        <p>Nháp mới và khách cần người thật sẽ hiện ở đây.</p>
        <button type="button" onClick={() => onModeChange("all")}>
          Xem tất cả hội thoại
        </button>
      </li>
    );
  } else if (visible.length === 0) {
    body = (
      <li className="ib-empty">
        <div className="t">Không có hội thoại nào khớp</div>
        <button
          type="button"
          onClick={() => {
            setSearch("");
            setShowUser(true);
            setShowGroup(true);
            setBotFilter("all");
          }}
        >
          Xoá tìm kiếm và bộ lọc
        </button>
      </li>
    );
  } else {
    body = visible.map((c) => (
      <li
        key={c.thread_id}
        className="ib-row"
        aria-current={c.thread_id === selected ? "true" : undefined}
        onClick={() => {
          setSelected(c.thread_id);
          setInfoOpen(false);
        }}
      >
        <Avatar name={displayName(c)} group={c.thread_type === "group"}>
          <span className="pick" onClick={(e) => e.stopPropagation()}>
            <input type="checkbox" checked={checked.has(c.thread_id)} onChange={() => toggle(c.thread_id)} aria-label={`Chọn ${displayName(c)}`} />
          </span>
        </Avatar>
        <div className="ib-row-main">
          <div className="ib-row-top">
            <span className="ib-row-name">{displayName(c)}</span>
            <span className="ib-row-time">{shortTime(c.last_message_at)}</span>
          </div>
          <div className="ib-row-last">{c.last_text}</div>
          <div className="ib-badges">
            <TaskBadge c={c} now={now} />
            <TagBadge bot={c.bot} profiles={profiles} offTag={offTag} />
          </div>
        </div>
      </li>
    ));
  }

  return (
    <div className={current ? "inbox has-thread" : "inbox"}>
      {/* Cột danh sách */}
      <div className="ib-list surface">
        <div className="ib-tools">
          <div className="ib-seg" role="tablist">
            <button type="button" role="tab" aria-selected={mode === "can"} onClick={() => onModeChange("can")}>
              Cần xử lý {actionCount > 0 && <span className="num">{actionCount}</span>}
            </button>
            <button type="button" role="tab" aria-selected={mode === "all"} onClick={() => onModeChange("all")}>
              Tất cả
            </button>
          </div>
          <div className="ib-search-row">
            <label className="ib-search">
              <Search aria-hidden />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Tìm tên khách, nhóm" aria-label="Tìm hội thoại" />
            </label>
            <Popover
              align="end"
              trigger={({ toggle: t }) => (
                <button type="button" className="filter-btn" onClick={t}>
                  <ListFilter aria-hidden />
                  Lọc{filterCount > 0 ? ` (${filterCount})` : ""}
                </button>
              )}
            >
              {() => (
                <>
                  <div className="menu-title">Loại hội thoại</div>
                  {(
                    [
                      ["Cá nhân", showUser, setShowUser],
                      ["Nhóm", showGroup, setShowGroup],
                    ] as const
                  ).map(([label, on, set]) => (
                    <button key={label} type="button" role="menuitemcheckbox" aria-checked={on} className="menu-item" onClick={() => set(!on)}>
                      <span className="menu-text">{label}</span>
                      {on && <Check className="check" aria-hidden />}
                    </button>
                  ))}
                  <div className="menu-sep" />
                  <div className="menu-title">Nhãn trợ lý</div>
                  {(
                    [
                      ["all", "Mọi nhãn"],
                      ...profiles.map((p) => [p.id, `🏷 ${p.tag || "(chưa đặt nhãn)"} — ${p.name}`] as const),
                      ["none", "Chưa gắn nhãn"],
                      ["off", `🚫 ${offTag}`],
                    ] as const
                  ).map(([v, label]) => (
                    <button
                      key={String(v)}
                      type="button"
                      role="menuitemradio"
                      aria-checked={botFilter === v}
                      className="menu-item"
                      onClick={() => setBotFilter(v)}
                    >
                      <span className="menu-text">{label}</span>
                      {botFilter === v && <Check className="check" aria-hidden />}
                    </button>
                  ))}
                </>
              )}
            </Popover>
          </div>
        </div>
        {!labelsAvailable && <div className="notice warn ib-msg">Chưa đọc được nhãn Zalo (Zalo chưa kết nối).</div>}
        {notice && <div className="notice ok ib-msg">{notice}</div>}
        {assignError && <div className="notice bad ib-msg">{assignError}</div>}
        {checked.size > 0 && (
          <div className="ib-bulk">
            <strong>Đã chọn {checked.size}</strong>
            <LabelMenu profiles={profiles} offTag={offTag} onPick={(v) => assign([...checked], v)} label="Gắn nhãn" allowClear />
            <button type="button" className="small-btn" onClick={() => setBulkSchedule(true)}>
              Lên lịch
            </button>
            <button
              type="button"
              className="link small"
              onClick={() => setChecked((s) => new Set([...s, ...visible.map((c) => c.thread_id)]))}
            >
              Chọn cả {visible.length}
            </button>
            <button type="button" className="link small" onClick={() => setChecked(new Set())}>
              Bỏ chọn
            </button>
          </div>
        )}
        <ul className={checked.size ? "ib-rows picking" : "ib-rows"}>{body}</ul>
      </div>

      {/* Cột hội thoại + cột thông tin */}
      {current ? (
        <>
          <Thread
            key={current.thread_id}
            conversation={current}
            profiles={profiles}
            offTag={offTag}
            canSend={canSend}
            now={now}
            onChanged={load}
            onBack={() => setSelected(null)}
            onInfo={() => setInfoOpen(true)}
          />
          <div className={infoOpen ? "scrim open ib-scrim" : "scrim ib-scrim"} onClick={() => setInfoOpen(false)} />
          <aside className={infoOpen ? "ib-info open" : "ib-info"} aria-label="Thông tin hội thoại">
            <button type="button" className="icon-only ib-info-close" onClick={() => setInfoOpen(false)} aria-label="Đóng">
              <X aria-hidden />
            </button>
            <div className="info-sec">
              <div className="info-title">Nhãn trợ lý (trong Zalo)</div>
              <LabelMenu
                profiles={profiles}
                offTag={offTag}
                bot={current.bot}
                onPick={(v) => assign([current.thread_id], v)}
                allowClear
                block
              />
              <p className="info-hint">Đổi ở đây hay trên điện thoại đều được, hai bên luôn khớp.</p>
            </div>
            <ScheduleSidebar
              key={`s-${current.thread_id}`}
              target={{ threadId: current.thread_id, threadType: current.thread_type, name: current.name }}
            />
            <div className="info-sec">
              <div className="info-title">Khách</div>
              <dl className="info-dl">
                <dt>Loại</dt>
                <dd>{current.thread_type === "group" ? "Nhóm" : "Chat riêng"}</dd>
                <dt>Nhắn lần đầu</dt>
                <dd>{fullDate(current.firstMessageAt)}</dd>
                <dt>Nhận tin chủ động</dt>
                <dd>{current.no_proactive ? "Không" : "Có"}</dd>
              </dl>
            </div>
          </aside>
        </>
      ) : (
        <div className="ib-thread" />
      )}

      {bulkSchedule && (
        <ScheduleForm
          defaultTargets={checkedList.map((c) => ({ threadId: c.thread_id, threadType: c.thread_type, name: c.name }))}
          onClose={() => setBulkSchedule(false)}
          onSaved={() => {
            setBulkSchedule(false);
            setNotice(`Đã lên lịch cho ${checkedList.length} hội thoại. Xem ở mục Lịch gửi.`);
          }}
        />
      )}
    </div>
  );
}

/** Chọn nhãn trợ lý — ghi thẳng nhãn thật trong Zalo. */
function LabelMenu({
  profiles,
  offTag,
  bot,
  onPick,
  label,
  allowClear,
  block,
}: {
  profiles: Profile[];
  offTag: string;
  bot?: BotState;
  onPick: (v: LabelValue) => void;
  label?: string;
  allowClear?: boolean;
  block?: boolean;
}) {
  const currentText = !bot
    ? label
    : bot.kind === "off"
      ? `🚫 ${offTag}`
      : bot.kind === "profile"
        ? `${profiles.find((p) => p.id === bot.profileId)?.tag || bot.name} — ${bot.name}`
        : "Chưa gắn (trợ lý im)";
  return (
    <Popover
      align={block ? "start" : "end"}
      trigger={({ toggle }) => (
        <button type="button" className={block ? "label-btn" : "small-btn"} onClick={toggle}>
          {block && <Tag aria-hidden />}
          <span className={block ? "t" : ""}>{currentText}</span>
          <ChevronDown aria-hidden />
        </button>
      )}
    >
      {(close) => {
        const pick = (v: LabelValue) => {
          close();
          onPick(v);
        };
        return (
          <>
            {profiles.map((p) => (
              <button key={p.id} type="button" className="menu-item" disabled={!p.tag} onClick={() => pick(p.id)}>
                <span className="menu-text">
                  <span>🏷 {p.tag || "(chưa đặt nhãn)"}</span>
                  <span className="menu-sub">
                    {p.name} · {p.sendMode === "auto" ? "Tự gửi" : "Soạn nháp"}
                  </span>
                </span>
              </button>
            ))}
            <button type="button" className="menu-item" onClick={() => pick("off")}>
              <span className="menu-text">
                <span>🚫 {offTag}</span>
                <span className="menu-sub">Trợ lý không trả lời hội thoại này</span>
              </span>
            </button>
            {allowClear && (
              <>
                <div className="menu-sep" />
                <button type="button" className="menu-item" onClick={() => pick(null)}>
                  <span className="menu-text">Gỡ nhãn trợ lý</span>
                </button>
              </>
            )}
          </>
        );
      }}
    </Popover>
  );
}

function Thread({
  conversation,
  profiles,
  offTag,
  canSend,
  now,
  onChanged,
  onBack,
  onInfo,
}: {
  conversation: Conversation;
  profiles: Profile[];
  offTag: string;
  canSend: boolean;
  now: number;
  onChanged: () => void;
  onBack: () => void;
  onInfo: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const id = conversation.thread_id;
  const bot = conversation.bot;

  const load = useCallback(() => {
    api<{ messages: Message[] }>(`/api/zalo/conversations/${encodeURIComponent(id)}/messages`)
      .then((r) => setMessages(r.messages))
      .catch(() => undefined);
  }, [id]);
  usePolling(load, 3000);

  const count = messages.length;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [count]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/zalo/conversations/${encodeURIComponent(id)}/send`, { body: { text } });
      setText("");
      load();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const profile = bot.kind === "profile" ? profiles.find((p) => p.id === bot.profileId) : undefined;
  const sub =
    bot.kind === "profile"
      ? `🏷 ${profile?.tag || bot.name} · ${bot.name} · ${profile?.sendMode === "auto" ? "Tự gửi" : "Soạn nháp"}`
      : bot.kind === "off"
        ? `🚫 ${offTag} · trợ lý không trả lời`
        : "Chưa gắn nhãn · trợ lý im";

  return (
    <div className="ib-thread">
      <div className="ib-thread-head">
        <button type="button" className="ghost ib-back" onClick={onBack} aria-label="Về danh sách">
          <ArrowLeft aria-hidden />
        </button>
        <Avatar name={displayName(conversation)} group={conversation.thread_type === "group"} small />
        <div className="ib-thread-title">
          <div className="n">{displayName(conversation)}</div>
          <div className="s">{sub}</div>
        </div>
        <button type="button" className="icon-only ib-info-btn" onClick={onInfo} aria-label="Nhãn, lịch gửi, thông tin khách" title="Nhãn, lịch gửi, thông tin khách">
          <Info aria-hidden />
        </button>
      </div>
      <div className="ib-messages page-bg">
        {messages.map((m) => (
          <div key={m.id} className={m.direction === "out" ? "msg me" : "msg"}>
            <div className="msg-bubble">
              {conversation.thread_type === "group" && m.direction === "in" && m.sender_name && <div className="msg-sender">{m.sender_name}</div>}
              {m.text ?? <em title={m.kind}>{kindText(m.kind)}</em>}
              <div className="msg-meta">
                {m.kind === "scheduled" ? "Lịch hẹn · " : m.source === "ai" ? "Trợ lý · " : m.source === "owner" ? "Bạn · " : ""}
                {shortTime(m.created_at)}
              </div>
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="ib-compose surface">
        {conversation.waitingHuman && (
          <div className="task-card">
            <div className="task-head">
              <Hand aria-hidden />
              Chờ người thật ·{" "}
              <span className="badge" data-level="high">
                chờ {waitText(now - conversation.last_message_at)}
              </span>
              {conversation.handoff_reason && <span className="push">{conversation.handoff_reason}</span>}
            </div>
            <p className="small muted">Trợ lý không trả lời hội thoại này tới {timeAndDay(conversation.handoff_until)}. Bạn trả lời khách ở ô bên dưới.</p>
            <div className="task-actions">
              <button
                type="button"
                onClick={() => api(`/api/zalo/conversations/${encodeURIComponent(id)}/resume`, { method: "POST" }).then(onChanged)}
              >
                Cho trợ lý trả lời tiếp
              </button>
            </div>
          </div>
        )}
        <DraftList threadId={id} canSend={canSend} now={now} onSent={() => (load(), onChanged())} pollKey={count} />
        {error && <div className="notice bad small">{error}</div>}
        <form className="compose-row" onSubmit={send}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={canSend ? "Nhắn với tư cách chủ tài khoản…" : "Zalo chưa kết nối"}
            disabled={!canSend}
            aria-label="Tin nhắn"
          />
          <button type="submit" disabled={!canSend || busy || !text.trim()}>
            {busy ? "Đang gửi…" : "Gửi"}
          </button>
        </form>
      </div>
    </div>
  );
}

/** Nháp AI soạn chờ chủ duyệt: sửa thoải mái rồi Gửi, hoặc Bỏ. */
function DraftList({ threadId, canSend, now, onSent, pollKey }: { threadId: string; canSend: boolean; now: number; onSent: () => void; pollKey: number }) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    api<{ drafts: Draft[] }>(`/api/drafts?thread=${encodeURIComponent(threadId)}`)
      .then((r) => setDrafts(r.drafts))
      .catch(() => undefined);
  }, [threadId]);
  usePolling(load, 4000);
  useEffect(() => {
    load();
  }, [pollKey, load]);

  if (!drafts.length) return null;
  const act = async (d: Draft, kind: "send" | "discard") => {
    setBusy(d.id);
    setError("");
    try {
      await api(`/api/drafts/${d.id}/${kind}`, { body: kind === "send" ? { text: edits[d.id] ?? d.text } : {} });
      load();
      onSent();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      {drafts.map((d) => {
        const waited = now - d.createdAt;
        const level = waitLevel(waited);
        return (
          <div key={d.id} className="task-card">
            <div className="task-head">
              <PencilLine aria-hidden />
              Trợ lý soạn nháp ·{" "}
              <span className={level ? "badge" : "badge task"} data-level={level || undefined}>
                chờ {waitText(waited)}
              </span>
              {d.handoff && <span className="push">AI đề nghị chuyển cho bạn</span>}
            </div>
            <textarea rows={3} value={edits[d.id] ?? d.text} onChange={(e) => setEdits((m) => ({ ...m, [d.id]: e.target.value }))} aria-label="Nội dung nháp" />
            <div className="task-actions">
              <button type="button" className="primary" disabled={!canSend || busy === d.id} onClick={() => act(d, "send")}>
                {busy === d.id ? "Đang gửi…" : "Gửi"}
              </button>
              <button type="button" className="ghost" disabled={busy === d.id} onClick={() => act(d, "discard")}>
                Bỏ nháp
              </button>
              {!canSend && <span className="muted small">Zalo chưa kết nối</span>}
            </div>
          </div>
        );
      })}
      {error && <div className="notice bad small">{error}</div>}
    </>
  );
}
