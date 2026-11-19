import type { AssistantStore } from "../core/assistantStore.js";
import type { ReplierAccount } from "../core/replier.js";
import { WAIT_LOOKBACK_MS, WAIT_REPLY_MS } from "../core/waiting.js";
import { vnDay } from "../care/prompt.js";
import type { DB } from "../server/db.js";

const VN_OFFSET = 7 * 3_600_000;
const DAY = 86_400_000;

/** Danh mục chỉ số chọn được cho báo cáo (thứ tự = thứ tự hiện trong báo cáo). */
export const METRICS = [
  { key: "messages", label: "Tin khách nhắn riêng" },
  { key: "new_customers", label: "Khách mới nhắn lần đầu" },
  { key: "ai_sent", label: "Tin trợ lý đã gửi" },
  { key: "response_time", label: "Thời gian phản hồi khách" },
  { key: "drafts", label: "Nháp: gửi nguyên văn / bạn sửa / bỏ" },
  { key: "pending", label: "Nháp đang chờ duyệt" },
  { key: "waiting", label: "Khách chờ trả lời quá 30 phút" },
  { key: "handoff", label: "Hội thoại chờ bạn trực tiếp" },
  { key: "care", label: "Chăm sóc khách: đã gửi, tới lượt" },
  { key: "groups", label: "Nhóm Zalo: người vào, rời" },
  { key: "crm", label: "CRM: lead đã lưu, khách nối được CRM" },
] as const;
export type MetricKey = (typeof METRICS)[number]["key"];
export const DEFAULT_METRICS: MetricKey[] = ["messages", "ai_sent", "pending", "waiting", "handoff", "care"];

export interface Report {
  id: number;
  accountId: number;
  name: string;
  frequency: "daily" | "weekly";
  /** 0 = Chủ nhật … 6 = Thứ Bảy (giờ VN), chỉ dùng cho báo cáo tuần. */
  weekday: number;
  /** Phút trong ngày giờ VN (VD 1050 = 17:30). */
  atMinute: number;
  /** "self" = Cloud của tôi; còn lại là uid Zalo của admin. */
  recipients: string[];
  metrics: MetricKey[];
  enabled: boolean;
  lastKey: string;
}

const toReport = (r: Record<string, unknown>): Report => ({
  id: Number(r.id),
  accountId: Number(r.account_id),
  name: String(r.name ?? ""),
  frequency: r.frequency === "weekly" ? "weekly" : "daily",
  weekday: Number(r.weekday),
  atMinute: Number(r.at_minute),
  recipients: safeList(r.recipients),
  metrics: safeList(r.metrics).filter((k): k is MetricKey => METRICS.some((m) => m.key === k)),
  enabled: Boolean(r.enabled),
  lastKey: String(r.last_key ?? ""),
});
function safeList(v: unknown): string[] {
  try {
    const a = JSON.parse(String(v ?? "[]"));
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

export const minuteVN = (ms: number) => {
  const d = new Date(ms + VN_OFFSET);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};
export const weekdayVN = (ms: number) => new Date(ms + VN_OFFSET).getUTCDay();
const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const dm = (ms: number) => vnDay(ms).slice(5).split("-").reverse().join("/");
const WD = ["Chủ nhật", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy"];
const dur = (ms: number) => {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "dưới 1 phút";
  if (m < 60) return `${m} phút`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} giờ ${m % 60} phút` : `${h} giờ`;
};

export function describeSchedule(r: Pick<Report, "frequency" | "weekday" | "atMinute">): string {
  return r.frequency === "weekly" ? `${WD[r.weekday]} hằng tuần lúc ${hm(r.atMinute)}` : `Hằng ngày lúc ${hm(r.atMinute)}`;
}

export interface ReportDeps {
  db: DB;
  assistant: AssistantStore;
  accountIds(): number[];
  account(id: number): ReplierAccount | undefined;
  /** Uid admin của tài khoản (người nhận hợp lệ). */
  adminIds(accountId: number): string[];
  /** Khung "Cloud của tôi" của nick (Zalo cho mã riêng); không có thì dùng mã nick. */
  selfThread?(accountId: number): string;
  careDue?(accountId: number, now: number): number;
  now?: () => number;
  log?: (msg: string, extra?: object) => void;
}

/** Báo cáo định kỳ cho admin qua Zalo: lịch ngày / tuần, chọn chỉ số, chọn người nhận. */
export class Reports {
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(private readonly d: ReportDeps) {
    this.now = d.now ?? Date.now;
  }

  list(accountId: number): Report[] {
    return (this.d.db.prepare("SELECT * FROM reports WHERE account_id = ? ORDER BY id").all(accountId) as Record<string, unknown>[]).map(toReport);
  }

  get(accountId: number, id: number): Report | undefined {
    const r = this.d.db.prepare("SELECT * FROM reports WHERE account_id = ? AND id = ?").get(accountId, id) as Record<string, unknown> | undefined;
    return r ? toReport(r) : undefined;
  }

  /** Tạo hoặc sửa (có id). Kiểm hợp lệ: ít nhất một chỉ số, một người nhận là chính nick hoặc admin. */
  save(accountId: number, input: Partial<Omit<Report, "accountId" | "lastKey">>, id?: number): Report {
    const prev = id ? this.get(accountId, id) : undefined;
    if (id && !prev) throw new Error("Không có báo cáo này");
    const admins = new Set(this.d.adminIds(accountId));
    const v = {
      name: String(input.name ?? prev?.name ?? "").trim().slice(0, 80) || "Báo cáo",
      frequency: (input.frequency ?? prev?.frequency ?? "daily") === "weekly" ? "weekly" : "daily",
      weekday: Math.min(6, Math.max(0, Math.round(Number(input.weekday ?? prev?.weekday ?? 1)))),
      atMinute: Math.min(1439, Math.max(0, Math.round(Number(input.atMinute ?? prev?.atMinute ?? 1050)))),
      recipients: [...new Set((input.recipients ?? prev?.recipients ?? ["self"]).map(String))].filter((r) => r === "self" || admins.has(r)),
      metrics: [...new Set((input.metrics ?? prev?.metrics ?? DEFAULT_METRICS).map(String))].filter((k): k is MetricKey => METRICS.some((m) => m.key === k)),
      enabled: input.enabled ?? prev?.enabled ?? true,
    };
    if (!v.metrics.length) throw new Error("Chọn ít nhất một chỉ số");
    if (!v.recipients.length) throw new Error("Chọn ít nhất một người nhận");
    const args = [v.name, v.frequency, v.weekday, v.atMinute, JSON.stringify(v.recipients), JSON.stringify(v.metrics), v.enabled ? 1 : 0];
    if (prev) {
      this.d.db
        .prepare("UPDATE reports SET name = ?, frequency = ?, weekday = ?, at_minute = ?, recipients = ?, metrics = ?, enabled = ? WHERE id = ?")
        .run(...args, prev.id);
      return this.get(accountId, prev.id)!;
    }
    // Báo cáo mới: không gửi bù cho kỳ hiện tại nếu giờ hẹn đã qua lúc tạo.
    const key = this.dueKey({ ...v, frequency: v.frequency as Report["frequency"] }) ?? "";
    const r = this.d.db
      .prepare("INSERT INTO reports (account_id, name, frequency, weekday, at_minute, recipients, metrics, enabled, last_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(accountId, ...args, key, this.now());
    return this.get(accountId, Number(r.lastInsertRowid))!;
  }

  remove(accountId: number, id: number) {
    this.d.db.prepare("DELETE FROM reports WHERE account_id = ? AND id = ?").run(accountId, id);
  }

  /** Khoá kỳ đang tới hạn (null nếu chưa tới giờ hôm nay / không phải thứ đã chọn). */
  dueKey(r: Pick<Report, "frequency" | "weekday" | "atMinute">): string | null {
    const now = this.now();
    if (minuteVN(now) < r.atMinute) return null;
    if (r.frequency === "weekly" && weekdayVN(now) !== r.weekday) return null;
    return vnDay(now);
  }

  /** Nội dung báo cáo: các chỉ số chọn trong kỳ (24 giờ / 7 ngày qua) tính tới lúc này. */
  build(accountId: number, metrics: readonly MetricKey[], frequency: Report["frequency"], name = "Báo cáo"): string {
    const acc = this.d.account(accountId);
    if (!acc) return "";
    const now = this.now();
    const from = now - (frequency === "weekly" ? 7 * DAY : DAY);
    const db = this.d.db;
    const one = (sql: string, ...a: (string | number)[]) => db.prepare(sql).get(accountId, ...a) as Record<string, number | null>;
    const lines: string[] = [
      `📋 ${name} · ${frequency === "weekly" ? `7 ngày qua (${dm(from)}–${dm(now)})` : `24 giờ qua (tới ${hm(minuteVN(now))} ${dm(now)})`}`,
    ];
    const add = (label: string, value: string) => lines.push(`- ${label}: ${value}`);
    // Chat với admin và "Cloud của tôi" không phải khách: loại khỏi số liệu.
    const ex = [...this.d.adminIds(accountId), acc.ownId(), this.d.selfThread?.(accountId) ?? ""].filter(Boolean);
    const exSql = ex.length ? ` AND m.thread_id NOT IN (${ex.map(() => "?").join(", ")})` : "";
    const userMsgs = `FROM messages m JOIN conversations c ON c.account_id = m.account_id AND c.thread_id = m.thread_id
      WHERE m.account_id = ? AND c.thread_type = 'user' AND m.created_at >= ?${exSql}`;
    for (const k of metrics) {
      if (k === "messages") {
        const r = one(`SELECT COUNT(*) AS n, COUNT(DISTINCT m.thread_id) AS p ${userMsgs} AND m.direction = 'in'`, from, ...ex);
        add("Tin khách nhắn riêng", `${r.n ?? 0} tin từ ${r.p ?? 0} người`);
      } else if (k === "new_customers") {
        const r = one(
          `SELECT COUNT(*) AS n FROM (SELECT m.thread_id, MIN(m.created_at) AS f FROM messages m JOIN conversations c
             ON c.account_id = m.account_id AND c.thread_id = m.thread_id WHERE m.account_id = ? AND c.thread_type = 'user'${exSql}
             GROUP BY m.thread_id) WHERE f >= ?`,
          ...ex,
          from,
        );
        add("Khách mới nhắn lần đầu", `${r.n ?? 0} người`);
      } else if (k === "ai_sent") {
        const r = one("SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND source = 'ai' AND kind = 'text' AND created_at >= ?", from);
        add("Tin trợ lý đã gửi", `${r.n ?? 0} tin`);
      } else if (k === "response_time") {
        add("Thời gian phản hồi khách", this.responseTime(accountId, from, ex));
      } else if (k === "drafts") {
        const s = this.d.assistant.draftStats(accountId, from);
        const total = s.sentAsIs + s.edited + s.discarded;
        add("Nháp trợ lý", total ? `${s.sentAsIs} gửi nguyên văn, ${s.edited} bạn sửa, ${s.discarded} bỏ (${Math.round((s.sentAsIs / total) * 100)}% dùng nguyên văn)` : "chưa có nháp nào được quyết");
      } else if (k === "pending") {
        add("Nháp đang chờ duyệt", `${this.d.assistant.pending(accountId).length}`);
      } else if (k === "waiting") {
        const admins = new Set(this.d.adminIds(accountId));
        const w = [...acc.inbox.waitingReplies(now, WAIT_REPLY_MS, WAIT_LOOKBACK_MS).keys()].filter((id) => !admins.has(id));
        const names = w.slice(0, 5).map((id) => acc.inbox.conversation(id)?.name || "khách");
        add("Khách chờ trả lời quá 30 phút", w.length ? `${w.length} (${names.join(", ")}${w.length > names.length ? "…" : ""})` : "không có");
      } else if (k === "handoff") {
        add("Hội thoại chờ bạn trực tiếp", `${acc.inbox.counts(now).waitingHuman}`);
      } else if (k === "care") {
        const r = one("SELECT COUNT(*) AS n FROM care_log WHERE account_id = ? AND kind = 'sent' AND at >= ?", from);
        add("Chăm sóc khách", `${r.n ?? 0} tin đã gửi, ${this.d.careDue?.(accountId, now) ?? 0} khách tới lượt hôm nay`);
      } else if (k === "groups") {
        const r = one(
          "SELECT SUM(kind = 'join') AS j, SUM(kind <> 'join') AS l FROM group_events WHERE account_id = ? AND at >= ?",
          from,
        );
        add("Nhóm Zalo", `${r.j ?? 0} người vào, ${r.l ?? 0} người rời`);
      } else if (k === "crm") {
        const saved = one("SELECT COUNT(*) AS n FROM crm_saved WHERE account_id = ? AND at >= ?", from);
        const linked = db
          .prepare("SELECT COUNT(*) AS n FROM crm_zalo z JOIN conversations c ON c.account_id = z.account_id AND c.thread_id = z.uid WHERE z.account_id = ? AND z.uid <> ''")
          .get(accountId) as { n: number };
        add("CRM", `${saved.n ?? 0} lead mới lưu, ${linked.n ?? 0} khách Zalo đã nối được CRM`);
      }
    }
    lines.push("Mở Trợ lý CDN, mục Cần xử lý để làm tiếp.");
    return lines.join("\n");
  }

  /** Trung vị thời gian từ tin khách (đầu một lượt) tới tin trả lời đầu tiên của người hoặc trợ lý. */
  responseTime(accountId: number, from: number, exclude: string[] = []): string {
    const exSql = exclude.length ? ` AND m.thread_id NOT IN (${exclude.map(() => "?").join(", ")})` : "";
    const rows = this.d.db
      .prepare(
        `SELECT m.thread_id, m.direction, m.created_at FROM messages m JOIN conversations c
           ON c.account_id = m.account_id AND c.thread_id = m.thread_id
         WHERE m.account_id = ? AND c.thread_type = 'user' AND m.created_at >= ? AND m.kind NOT IN ('welcome', 'scheduled', 'report')${exSql}
         ORDER BY m.thread_id, m.created_at`,
      )
      .all(accountId, from, ...exclude) as { thread_id: string; direction: string; created_at: number }[];
    const waits: number[] = [];
    let thread = "";
    let since = 0;
    for (const m of rows) {
      if (m.thread_id !== thread) {
        thread = m.thread_id;
        since = 0;
      }
      if (m.direction === "in") {
        if (!since) since = m.created_at;
      } else if (since) {
        waits.push(m.created_at - since);
        since = 0;
      }
    }
    if (!waits.length) return "chưa có lượt nào được trả lời";
    waits.sort((a, b) => a - b);
    const med = waits[Math.floor(waits.length / 2)]!;
    const fast = waits.filter((w) => w <= 15 * 60_000).length;
    return `trung bình giữa ${dur(med)}, ${Math.round((fast / waits.length) * 100)}% được trả lời trong 15 phút (${waits.length} lượt)`;
  }

  /** Gửi một báo cáo tới người nhận. Trả số người nhận đã gửi được. */
  async send(r: Report): Promise<number> {
    const acc = this.d.account(r.accountId);
    if (!acc?.isConnected()) throw new Error("Zalo chưa kết nối");
    const text = this.build(r.accountId, r.metrics, r.frequency, r.name);
    const admins = new Set(this.d.adminIds(r.accountId));
    let ok = 0;
    for (const to of r.recipients) {
      const thread = to === "self" ? this.d.selfThread?.(r.accountId) || acc.ownId() : admins.has(to) ? to : "";
      if (!thread) continue;
      try {
        const ids = await acc.sendText(thread, "user", text);
        if (to !== "self") acc.inbox.recordOutbound(thread, "user", text, "ai", ids[0] ?? null, this.now(), "report");
        ok++;
      } catch (err) {
        this.d.log?.("Không gửi được báo cáo", { report: r.id, to, err: (err as Error).message });
      }
    }
    return ok;
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const id of this.d.accountIds()) {
        if (!this.d.account(id)?.isConnected()) continue;
        for (const r of this.list(id)) {
          if (!r.enabled) continue;
          const key = this.dueKey(r);
          if (!key || key === r.lastKey) continue;
          this.d.db.prepare("UPDATE reports SET last_key = ? WHERE id = ?").run(key, r.id);
          await this.send(r).catch((err) => this.d.log?.("Lỗi gửi báo cáo", { report: r.id, err: (err as Error).message }));
        }
      }
    } finally {
      this.busy = false;
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
