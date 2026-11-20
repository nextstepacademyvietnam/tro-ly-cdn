import { useCallback, useEffect, useState } from "react";
import {
  Bell as BellIcon,
  Bot,
  Bug,
  CalendarClock,
  ChartLine,
  Check,
  ChevronsUpDown,
  House,
  Inbox,
  LayoutDashboard,
  LogOut,
  Menu,
  MessagesSquare,
  Pause,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  SunMoon,
  UserRound,
  UsersRound,
} from "lucide-react";
import { type Account, type Notice, api, prefs, setCurrentAccount } from "./api";
import { AuthScreen } from "./pages/AuthScreen";
import { type InboxMode, InboxPage } from "./pages/InboxPage";
import { GroupsPage } from "./pages/GroupsPage";
import { ProfilesPage } from "./pages/ProfilesPage";
import { SETTINGS_TABS, type SettingsTab, SettingsPage } from "./pages/SettingsPage";
import { TodayPage } from "./pages/TodayPage";
import { SchedulesPage } from "./schedules/SchedulePanels";
import { Popover, initials, timeAndDay } from "./ui";
import { UpdateBanner, UpdateDialog, useUpdate } from "./update/UpdateDialog";
import { FeedbackDialog } from "./feedback/FeedbackDialog";
import { OverviewPage } from "./pages/mkt/OverviewPage";
import { ChannelsPage } from "./pages/mkt/ChannelsPage";
import { ConnectionsPage } from "./pages/mkt/ConnectionsPage";
import "./mkt.css";
import "./care.css";

type Status = { hasAdmin: boolean; user: { username: string } | null; version?: string; features?: { mkt?: boolean } };
export type Page = "homnay" | "hop" | "schedules" | "groups" | "profiles" | "settings" | "mkt" | "mkt-kenh" | "mkt-ketnoi";
const MKT_PAGES: Page[] = ["mkt", "mkt-kenh", "mkt-ketnoi"];
type Theme = "system" | "light" | "dark";

const TITLES: Record<Page, string> = {
  homnay: "Hôm nay",
  hop: "Hộp thư",
  schedules: "Lịch gửi",
  groups: "Nhóm Zalo",
  profiles: "Tính cách",
  settings: "Cài đặt",
  mkt: "Tổng quan MKT",
  "mkt-kenh": "Kênh",
  "mkt-ketnoi": "Kết nối",
};
/** Tên mục trên menu (tiêu đề trang MKT dài hơn). */
const NAV_LABEL: Partial<Record<Page, string>> = { mkt: "Tổng quan" };
const THEME_LABEL: Record<Theme, string> = { system: "theo máy", light: "sáng", dark: "tối" };

/** Theme chạy bằng class .dark trên <html> (khối .dark của tokens.css); "theo máy" nghe prefers-color-scheme. */
function useTheme(theme: Theme) {
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", theme === "dark" || (theme === "system" && mq.matches));
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);
}

const stateOf = (a?: Account) =>
  a?.state === "connected" ? "on" : a?.state === "waiting_qr" || a?.state === "scanned" ? "wait" : a?.state === "error" ? "bad" : "off";
const stateText = (a?: Account) =>
  a?.state === "connected" ? "Đã kết nối" : a?.state === "waiting_qr" || a?.state === "scanned" ? "Chờ quét mã QR" : a?.state === "reconnecting" ? "Đang nối lại" : "Chưa kết nối";

/** Mục cũ (trước khi gom menu) → mục mới + tab con. Giữ để đường dẫn ?trang=accounts và mục đã lưu vẫn mở đúng chỗ. */
const LEGACY: Record<string, [Page, InboxMode | SettingsTab | null]> = {
  can: ["hop", "can"],
  zalo: ["hop", "can"],
  chamsoc: ["hop", "care"],
  accounts: ["settings", "zalo"],
  models: ["settings", "models"],
  org: ["settings", "org"],
};
function resolve(p: string | null): [Page, InboxMode | SettingsTab | null] | null {
  if (!p) return null;
  if (p in LEGACY) return LEGACY[p]!;
  return p in TITLES ? [p as Page, null] : null;
}
function savedPage(): [Page, InboxMode | SettingsTab | null] {
  // Đường dẫn mở thẳng một mục: ?trang=groups (ưu tiên hơn mục mở lần trước). Lần đầu mở app: Hôm nay.
  return resolve(new URLSearchParams(location.search).get("trang")) ?? resolve(prefs.get("tab")) ?? ["homnay", null];
}
const INBOX_MODES: InboxMode[] = ["can", "care", "all"];
const isSettingsTab = (v: unknown): v is SettingsTab => SETTINGS_TABS.some(([k]) => k === v);

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [initial] = useState(savedPage);
  const [page, setPage] = useState<Page>(initial[0]);
  const [inboxMode, setInboxMode] = useState<InboxMode>(() => {
    const v = INBOX_MODES.includes(initial[1] as InboxMode) ? (initial[1] as InboxMode) : (prefs.get("inbox") as InboxMode);
    return INBOX_MODES.includes(v) ? v : "can";
  });
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(() => {
    const v = isSettingsTab(initial[1]) ? initial[1] : new URLSearchParams(location.search).get("tab");
    return isSettingsTab(v) ? v : "zalo";
  });
  /** Hội thoại cần mở sẵn khi vào Hộp thư (bấm một khách ở trang Chăm sóc, hoặc ?hoi=<id>). */
  const [openThread, setOpenThread] = useState<string | null>(() => new URLSearchParams(location.search).get("hoi"));
  const [theme, setTheme] = useState<Theme>(() => (prefs.get("theme") as Theme) || "system");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const update = useUpdate();
  const [updateOpen, setUpdateOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [mktErrors, setMktErrors] = useState(0);

  const refresh = () => api<Status>("/api/status").then(setStatus);
  useEffect(() => {
    refresh().catch(() => setStatus({ hasAdmin: true, user: null }));
  }, []);
  useTheme(theme);

  const loadAccounts = useCallback(async () => {
    const r = await api<{ accounts: Account[] }>("/api/accounts");
    setAccounts(r.accounts);
    setAccountId((cur) => {
      const saved = cur ?? Number(prefs.get("account"));
      const id = r.accounts.some((a) => a.id === saved) ? saved : (r.accounts[0]?.id ?? null);
      setCurrentAccount(id);
      return id;
    });
  }, []);
  // Số kết nối MKT đang lỗi, hiện cạnh mục Kết nối.
  const mktOn = !!status?.features?.mkt;
  useEffect(() => {
    if (!status?.user || !mktOn) return;
    const load = () =>
      api<{ connections: { status: string }[] }>("/api/mkt/connections")
        .then((r) => setMktErrors(r.connections.filter((c) => c.status === "error").length))
        .catch(() => undefined);
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [status?.user, mktOn, page]);
  // Mục MKT tắt (bản cho khách) mà trang lưu lại là trang MKT: về Cần xử lý.
  useEffect(() => {
    if (status?.user && !mktOn && MKT_PAGES.includes(page)) setPage("homnay");
  }, [status?.user, mktOn, page]);
  useEffect(() => {
    if (!status?.user) return;
    loadAccounts().catch(() => undefined);
    const t = setInterval(() => loadAccounts().catch(() => undefined), 10_000);
    return () => clearInterval(t);
  }, [status?.user, loadAccounts]);

  const chooseAccount = (id: number) => {
    setCurrentAccount(id);
    prefs.set("account", String(id));
    setAccountId(id);
  };
  const go = (p: Page) => {
    prefs.set("tab", p);
    setPage(p);
    setMenuOpen(false);
  };
  const goInbox = (m: InboxMode, threadId?: string) => {
    prefs.set("inbox", m);
    setInboxMode(m);
    if (threadId) setOpenThread(threadId);
    go("hop");
  };
  const goSettings = (t: SettingsTab) => {
    setSettingsTab(t);
    go("settings");
  };
  const cycleTheme = () => {
    const next: Theme = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
    prefs.set("theme", next);
    setTheme(next);
  };
  const addAccount = async () => {
    const name = prompt("Tên tài khoản mới (VD: Nick CSKH):", "");
    if (name === null) return;
    const r = await api<{ account: Account }>("/api/accounts", { body: { name } });
    chooseAccount(r.account.id);
    goSettings("zalo");
    // Tài khoản mới chưa có nick: bắt đầu quét QR luôn, không bắt người dùng tự tìm nút.
    await api("/api/zalo/login", { method: "POST" }).catch(() => undefined);
    await loadAccounts();
  };

  if (!status) return <div className="center muted">Đang tải…</div>;
  if (!status.user) return <AuthScreen firstRun={!status.hasAdmin} onDone={refresh} />;

  const current = accounts.find((a) => a.id === accountId);
  const isMkt = MKT_PAGES.includes(page);
  const nav = (p: Page, Icon: typeof Inbox, count?: number | string) => (
    <button type="button" className="nav-item" aria-current={page === p ? "page" : undefined} onClick={() => go(p)}>
      <Icon aria-hidden />
      <span className="nav-label">{NAV_LABEL[p] ?? TITLES[p]}</span>
      {count ? <span className={typeof count === "string" ? "nav-count warn" : "nav-count"}>{count}</span> : null}
    </button>
  );

  return (
    <div className="app">
      <div className={menuOpen ? "scrim open" : "scrim"} onClick={() => setMenuOpen(false)} />
      <aside className={menuOpen ? "sidebar surface open" : "sidebar surface"} aria-label="Điều hướng">
        <div className="sidebar-head">
          <span className="logo-mark">
            <Bot aria-hidden />
          </span>
          <span className="logo-name">Trợ lý CDN</span>
        </div>
        <nav className="nav">
          <div className="nav-section first">Zalo</div>
          <Popover
            wrapClassName="acct-wrap"
            trigger={({ toggle }) => (
              <button type="button" className="acct-btn" onClick={toggle} title="Đổi tài khoản Zalo">
                <span className="acct-avatar">
                  {initials(current?.name ?? "") || "?"}
                  <span className={`state ${stateOf(current)}`} />
                </span>
                <span className="acct-text">
                  <span className="acct-name">{current?.name ?? "Chưa có tài khoản"}</span>
                  <span className="acct-sub">
                    {stateText(current)} · {accounts.length} tài khoản
                  </span>
                </span>
                <ChevronsUpDown aria-hidden />
              </button>
            )}
          >
            {(close) => (
              <>
                <div className="menu-title">Tài khoản Zalo</div>
                {accounts.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className="menu-item"
                    onClick={() => {
                      chooseAccount(a.id);
                      close();
                    }}
                  >
                    <span className={`dot ${stateOf(a)}`} />
                    <span className="menu-text">
                      <span>{a.name}</span>
                      <span className="menu-sub">{stateText(a)}</span>
                    </span>
                    {a.id === accountId && <Check className="check" aria-label="Đang chọn" />}
                  </button>
                ))}
                <div className="menu-sep" />
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    close();
                    addAccount().catch(() => undefined);
                  }}
                >
                  <Plus aria-hidden />
                  <span className="menu-text">Thêm tài khoản Zalo</span>
                </button>
              </>
            )}
          </Popover>
          {nav("homnay", House, current?.needsAction)}
          {nav("hop", MessagesSquare, current?.unreadConversations)}
          {nav("schedules", CalendarClock, current?.activeSchedules)}
          {nav("groups", UsersRound, current?.trackedGroups)}
          {nav("profiles", Sparkles)}
          {mktOn && (
            <>
              <div className="nav-section">MKT</div>
              {nav("mkt", LayoutDashboard)}
              {nav("mkt-kenh", ChartLine)}
              {nav("mkt-ketnoi", Plug, mktErrors ? `${mktErrors} lỗi` : undefined)}
            </>
          )}
          <div className="nav-bottom">{nav("settings", Settings, current && current.state !== "connected" ? "Chưa nối" : undefined)}</div>
        </nav>
        <div className="sidebar-foot">
          <div className="user-row">
            <UserRound className="icon" aria-hidden />
            <span className="user-name">{status.user.username}</span>
            <button
              type="button"
              className="icon-only"
              onClick={() => {
                setMenuOpen(false);
                setFeedbackOpen(true);
              }}
              aria-label="Báo lỗi, góp ý"
              title="Báo lỗi, góp ý"
            >
              <Bug aria-hidden />
            </button>
            <button type="button" className="icon-only" onClick={cycleTheme} aria-label="Đổi sáng / tối" title={`Giao diện: ${THEME_LABEL[theme]} (bấm để đổi)`}>
              <SunMoon aria-hidden />
            </button>
            <button
              type="button"
              className="icon-only"
              onClick={() => api("/api/logout", { method: "POST" }).then(refresh)}
              aria-label="Đăng xuất"
              title="Đăng xuất"
            >
              <LogOut aria-hidden />
            </button>
          </div>
          <button type="button" className="version-btn" onClick={() => setUpdateOpen(true)} title="Phiên bản và cập nhật">
            v{update.status?.current ?? status.version ?? ""}
            {update.status?.latest && <span className="version-new">Có bản mới</span>}
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="header">
          <button type="button" className="ghost menu-btn" onClick={() => setMenuOpen(true)} aria-label="Mở menu">
            <Menu aria-hidden />
          </button>
          <h1>{TITLES[page]}</h1>
          <div className="header-actions">
            {!isMkt && current && <PauseButton account={current} onChanged={loadAccounts} />}
            {(page === "mkt" || page === "mkt-kenh") && <MktRefreshButton />}
            <Bell account={current} onRead={loadAccounts} />
          </div>
        </header>
        <UpdateBanner status={update.status} onOpen={() => setUpdateOpen(true)} onChanged={() => void update.load()} />
        {feedbackOpen && <FeedbackDialog onClose={() => setFeedbackOpen(false)} version={update.status?.current ?? status.version ?? ""} page={TITLES[page]} />}
        {updateOpen && update.status && (
          <UpdateDialog status={update.status} restarting={update.restarting} onClose={() => setUpdateOpen(false)} onStatus={update.setStatus} />
        )}
        {(accountId || isMkt) && (
          <main key={`${page}-${isMkt ? "mkt" : accountId}-${page === "hop" ? openThread : ""}`} className="main-body">
            {page === "homnay" && (
              <div className="page">
                <TodayPage
                  account={current}
                  onOpenThread={(id, m) => goInbox(m, id)}
                  onGo={(p) => (p === "settings" ? goSettings("zalo") : p === "hop" ? goInbox("can") : go(p))}
                />
              </div>
            )}
            {page === "hop" && (
              <InboxPage
                account={current}
                initialThread={openThread}
                mode={inboxMode}
                careDue={current?.careDue}
                onModeChange={(m) => {
                  prefs.set("inbox", m);
                  setInboxMode(m);
                }}
                onGoAccounts={() => goSettings("zalo")}
              />
            )}
            {page === "schedules" && (
              <div className="page">
                <SchedulesPage />
              </div>
            )}
            {page === "groups" && (
              <div className="page">
                <GroupsPage account={current} onGoAccounts={() => goSettings("zalo")} />
              </div>
            )}
            {page === "profiles" && accountId && (
              <div className="page">
                <ProfilesPage accounts={accounts} accountId={accountId} onNeedEngine={() => goSettings("models")} />
              </div>
            )}
            {page === "settings" && (
              <div className="page narrow">
                <SettingsPage
                  tab={settingsTab}
                  onTab={setSettingsTab}
                  account={current}
                  accounts={accounts}
                  onAccountsChanged={loadAccounts}
                  onAddAccount={addAccount}
                />
              </div>
            )}
            {page === "mkt" && (
              <div className="page">
                <OverviewPage onGoConnect={() => go("mkt-ketnoi")} />
              </div>
            )}
            {page === "mkt-kenh" && (
              <div className="page">
                <ChannelsPage onGoConnect={() => go("mkt-ketnoi")} />
              </div>
            )}
            {page === "mkt-ketnoi" && (
              <div className="page">
                <ConnectionsPage />
              </div>
            )}
          </main>
        )}
      </div>
    </div>
  );
}

/** Làm mới số MKT ngay: lấy lại mọi nền tảng đã nối, rồi báo các trang MKT tải lại. */
function MktRefreshButton() {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await api("/api/mkt/refresh", { body: {} });
      // Lấy số chạy nền: chờ chút rồi tải lại vài lần.
      for (const ms of [4000, 12000, 30000]) setTimeout(() => window.dispatchEvent(new Event("mkt:lam-moi")), ms);
      setTimeout(() => setBusy(false), 4000);
    } catch {
      setBusy(false);
    }
  };
  return (
    <button type="button" className="mkt-refresh" onClick={run} disabled={busy} title="Lấy lại số mới nhất của mọi kênh đã nối">
      <RefreshCw aria-hidden className={busy ? "spin" : ""} />
      <span className="mkt-refresh-text">{busy ? "Đang làm mới…" : "Làm mới"}</span>
    </button>
  );
}

/** Công tắc dừng khẩn cấp ở header: AI không trả lời ai tới khi bật lại (lịch gửi vẫn chạy). */
function PauseButton({ account, onChanged }: { account: Account; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    try {
      await api("/api/assistant", { method: "PUT", body: { paused: !account.paused } });
      await onChanged();
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      className="pause-btn"
      onClick={toggle}
      disabled={busy}
      title={account.paused ? "Cho trợ lý trả lời lại các hội thoại có nhãn" : "Dừng mọi câu trả lời của AI ngay (lịch gửi vẫn chạy)"}
    >
      <span className={`dot ${account.paused ? "wait" : "on"}`} />
      <span className="pause-text">{account.paused ? "Trợ lý đang tạm dừng" : "Trợ lý đang chạy"}</span>
      {account.paused ? <Play aria-hidden /> : <Pause aria-hidden />}
    </button>
  );
}

/** Chuông thông báo: chuyển người thật, lỗi AI, khách xin dừng nhắn, nhắc cập nhật hướng dẫn. */
function Bell({ account, onRead }: { account?: Account; onRead: () => Promise<void> }) {
  const [items, setItems] = useState<Notice[]>([]);
  const unread = account?.unread ?? 0;
  return (
    <Popover
      align="end"
      className="wide"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          className="bell-btn"
          aria-label={unread ? `Thông báo, ${unread} chưa đọc` : "Thông báo"}
          title="Thông báo của trợ lý"
          onClick={async () => {
            if (!open) {
              const r = await api<{ notifications: Notice[] }>("/api/notifications").catch(() => ({ notifications: [] }));
              setItems(r.notifications);
              if (unread) {
                await api("/api/notifications/read-all", { method: "POST" }).catch(() => undefined);
                await onRead().catch(() => undefined);
              }
            }
            toggle();
          }}
        >
          <BellIcon aria-hidden />
          {unread > 0 && <span className="bell-badge">{unread}</span>}
        </button>
      )}
    >
      {() => (
        <>
          <div className="menu-title">Thông báo</div>
          {items.length === 0 ? (
            <p className="pop-body muted small">Chưa có thông báo nào.</p>
          ) : (
            <ul className="notif-list">
              {items.map((n) => (
                <li key={n.id} className={n.read ? "" : "unread"}>
                  <span>{n.text}</span>
                  <span className="muted small">{timeAndDay(n.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Popover>
  );
}
