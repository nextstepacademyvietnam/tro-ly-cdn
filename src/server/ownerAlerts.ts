import type { AssistantStore } from "../core/assistantStore.js";
import type { ReplierAccount } from "../core/replier.js";
import { WAIT_LOOKBACK_MS, WAIT_REPLY_MS } from "../core/waiting.js";
import { inQuietVN, vnDay } from "../care/prompt.js";
import type { DB } from "./db.js";

/** Nháp chờ duyệt quá ngần này thì nhắc chủ trên Zalo. */
export const STALE_DRAFT_MS = 15 * 60_000;
/** Giờ gửi tóm tắt cuối ngày (giờ VN, phút trong ngày): 17:30. */
export const DIGEST_AT_MIN = 17 * 60 + 30;
/** Gom các việc gấp ngần này rồi gửi một tin (khách nhắn dồn thì chủ không bị réo liên tục). */
const BATCH_MS = 60_000;
const VN_OFFSET = 7 * 3_600_000;

export interface OwnerAlertDeps {
  db: DB;
  assistant: AssistantStore;
  accountIds(): number[];
  account(id: number): ReplierAccount | undefined;
  /** Số khách tới lượt chăm sóc hôm nay. */
  careDue?(accountId: number, now: number): number;
  now?: () => number;
  log?: (msg: string, extra?: object) => void;
}

const minuteVN = (ms: number) => {
  const d = new Date(ms + VN_OFFSET);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};
const startOfDayVN = (ms: number) => Date.parse(`${vnDay(ms)}T00:00:00Z`) - VN_OFFSET;

/**
 * Báo chủ ngay trên Zalo của chính họ (khung "Cloud của tôi" / My Documents, thấy trên điện thoại):
 * - Việc gấp: khách cần người thật, nháp chờ duyệt quá 15 phút. Gom trong 1 phút thành một tin; giờ yên lặng
 *   21:30–07:30 thì giữ lại, sáng gửi một lần.
 * - Tóm tắt cuối ngày lúc 17:30: tin khách đến, trợ lý đã gửi, việc còn tồn.
 * Tin gửi từ app được nhận ra là của app nên không bị hiểu nhầm thành lệnh của chủ.
 */
export class OwnerAlerts {
  private readonly now: () => number;
  private readonly queue = new Map<number, { items: string[]; first: number }>();
  private readonly staleSeen = new Set<number>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(private readonly d: OwnerAlertDeps) {
    this.now = d.now ?? Date.now;
  }

  enabled(accountId: number): boolean {
    const r = this.d.db.prepare("SELECT owner_alerts FROM accounts WHERE id = ?").get(accountId) as { owner_alerts: number } | undefined;
    return Boolean(r?.owner_alerts);
  }

  setEnabled(accountId: number, on: boolean) {
    this.d.db.prepare("UPDATE accounts SET owner_alerts = ? WHERE id = ?").run(on ? 1 : 0, accountId);
    if (!on) this.queue.delete(accountId);
  }

  /** Thêm một việc gấp vào hàng chờ gửi chủ. */
  alert(accountId: number, text: string) {
    if (!this.enabled(accountId)) return;
    const q = this.queue.get(accountId) ?? { items: [], first: this.now() };
    if (q.items.length < 20) q.items.push(text.slice(0, 300));
    this.queue.set(accountId, q);
  }

  /** Gửi một tin vào "Cloud của tôi" của tài khoản. */
  async send(accountId: number, text: string): Promise<void> {
    const acc = this.d.account(accountId);
    if (!acc?.isConnected()) throw new Error("Zalo chưa kết nối");
    const own = acc.ownId();
    if (!own) throw new Error("Chưa biết mã Zalo của tài khoản này");
    await acc.sendText(own, "user", text);
  }

  async test(accountId: number): Promise<void> {
    await this.send(accountId, "🔔 Trợ lý CDN: thử báo tin. Việc gấp (khách cần bạn, nháp chờ lâu) và tóm tắt cuối ngày sẽ về đây.");
  }

  /** Tóm tắt trong ngày của một tài khoản; "" nếu không có gì đáng báo. */
  digest(accountId: number): string {
    const acc = this.d.account(accountId);
    if (!acc) return "";
    const now = this.now();
    const from = startOfDayVN(now);
    const count = (sql: string, ...args: (string | number)[]) => Number((this.d.db.prepare(sql).get(accountId, ...args) as { n: number }).n);
    const incoming = count("SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.account_id = m.account_id AND c.thread_id = m.thread_id WHERE m.account_id = ? AND c.thread_type = 'user' AND m.direction = 'in' AND m.created_at >= ?", from);
    const customers = count("SELECT COUNT(DISTINCT m.thread_id) AS n FROM messages m JOIN conversations c ON c.account_id = m.account_id AND c.thread_id = m.thread_id WHERE m.account_id = ? AND c.thread_type = 'user' AND m.direction = 'in' AND m.created_at >= ?", from);
    const aiSent = count("SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND source = 'ai' AND kind = 'text' AND created_at >= ?", from);
    const drafts = this.d.assistant.pending(accountId).length;
    const handoff = acc.inbox.counts(now).waitingHuman;
    const waiting = acc.inbox.waitingReplies(now, WAIT_REPLY_MS, WAIT_LOOKBACK_MS);
    const care = this.d.careDue?.(accountId, now) ?? 0;
    if (!incoming && !drafts && !handoff && !waiting.size && !care) return "";
    const names = [...waiting.keys()].slice(0, 5).map((id) => acc.inbox.conversation(id)?.name || "khách");
    const lines = [
      `📋 Trợ lý CDN, tóm tắt hôm nay (${vnDay(now).split("-").reverse().join("/")}):`,
      `- ${incoming} tin từ ${customers} người nhắn riêng; trợ lý đã gửi ${aiSent} tin.`,
    ];
    if (drafts) lines.push(`- ${drafts} nháp đang chờ bạn duyệt.`);
    if (handoff) lines.push(`- ${handoff} hội thoại đang chờ bạn trực tiếp trả lời.`);
    if (waiting.size) lines.push(`- ${waiting.size} khách chờ trả lời quá 30 phút: ${names.join(", ")}${waiting.size > names.length ? "…" : ""}.`);
    if (care) lines.push(`- ${care} khách tới lượt chăm sóc.`);
    lines.push("Mở Trợ lý CDN, mục Cần xử lý để làm tiếp.");
    return lines.join("\n");
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.now();
      for (const id of this.d.accountIds()) {
        if (!this.enabled(id)) continue;
        const acc = this.d.account(id);
        if (!acc?.isConnected()) continue;
        // Nháp chờ duyệt quá 15 phút (chỉ nháp trong 2 giờ gần đây để bật lại app không nhắc dồn nháp cũ).
        const stale = this.d.assistant
          .pending(id)
          .filter((d) => now - d.createdAt >= STALE_DRAFT_MS && now - d.createdAt < 2 * 3_600_000 && !this.staleSeen.has(d.id));
        if (stale.length) {
          for (const d of stale) this.staleSeen.add(d.id);
          const names = [...new Set(stale.map((d) => acc.inbox.conversation(d.threadId)?.name || "khách"))];
          this.alert(id, `Nháp trả lời chờ bạn duyệt quá 15 phút: ${names.join(", ")}.`);
        }
        const quiet = inQuietVN(now);
        const q = this.queue.get(id);
        if (q?.items.length && !quiet && now - q.first >= BATCH_MS) {
          this.queue.delete(id);
          const body = ["🔔 Trợ lý CDN cần bạn:", ...q.items.map((t) => `- ${t}`), "Mở app, mục Cần xử lý."].join("\n");
          await this.send(id, body).catch((err) => this.d.log?.("Không báo được chủ qua Zalo", { account: id, err: (err as Error).message }));
        }
        const day = vnDay(now);
        const row = this.d.db.prepare("SELECT digest_day FROM accounts WHERE id = ?").get(id) as { digest_day: string } | undefined;
        if (minuteVN(now) >= DIGEST_AT_MIN && !quiet && row && row.digest_day !== day) {
          this.d.db.prepare("UPDATE accounts SET digest_day = ? WHERE id = ?").run(day, id);
          const text = this.digest(id);
          if (text) await this.send(id, text).catch((err) => this.d.log?.("Không gửi được tóm tắt", { account: id, err: (err as Error).message }));
        }
      }
    } finally {
      this.busy = false;
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
