import type { DB } from "../../server/db.js";
import { describeNonText, type InboundEvent, type ThreadType } from "./protocol.js";

export type MessageSource = "zalo" | "owner" | "ai";

export interface ConversationRow {
  account_id: number;
  thread_id: string;
  thread_type: ThreadType;
  name: string;
  last_text: string;
  last_message_at: number;
  unread: number;
  /** Tính cách gắn trên trang quản trị (thắng nhãn Zalo). */
  assigned_profile_id: number | null;
  /** 1 = chủ tắt bot cho hội thoại này trên trang quản trị. */
  assigned_off: number;
  /** Đang chờ người thật tới mốc này (ms); 0 = không. */
  handoff_until: number;
  handoff_reason: string;
  /** 1 = khách đã xin không nhận tin chủ động. */
  no_proactive: number;
}

export interface MessageRow {
  id: number;
  thread_id: string;
  zalo_msg_id: string | null;
  sender_id: string;
  sender_name: string;
  direction: "in" | "out";
  source: MessageSource;
  text: string | null;
  kind: string;
  created_at: number;
}

/** Hộp thư Zalo của MỘT tài khoản, lưu trong SQLite (chỉ trên máy chạy app). */
export class Inbox {
  constructor(private readonly db: DB, readonly accountId: number) {}

  private touchConversation(threadId: string, type: ThreadType, preview: string, at: number, unreadDelta: number, name?: string) {
    this.db
      .prepare(
        `INSERT INTO conversations (account_id, thread_id, thread_type, name, last_text, last_message_at, unread)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, thread_id) DO UPDATE SET
           name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE conversations.name END,
           last_text = CASE WHEN excluded.last_message_at >= conversations.last_message_at THEN excluded.last_text ELSE conversations.last_text END,
           last_message_at = MAX(conversations.last_message_at, excluded.last_message_at),
           unread = MAX(0, conversations.unread + ?)`,
      )
      .run(this.accountId, threadId, type, name ?? "", preview.slice(0, 200), at, Math.max(0, unreadDelta), unreadDelta);
  }

  /**
   * Ghi một tin từ Zalo. Tin `isSelf` là chủ tài khoản tự gõ (điện thoại/máy tính) — trừ khi
   * app vừa gửi chính tin đó (`sentByApp`), lúc ấy đã được ghi bởi `recordOutbound`.
   * Trả về false nếu tin đã có (Zalo đôi khi gửi lại).
   */
  recordInbound(event: InboundEvent, opts: { conversationName?: string; sentByApp?: boolean } = {}): boolean {
    if (opts.sentByApp) return false;
    const text = event.isText ? event.text : null;
    const kind = event.isText ? "text" : event.msgType || "other";
    // Hội thoại phải có trước (khoá ngoại).
    this.touchConversation(event.threadId, event.threadType, "", 0, 0, opts.conversationName);
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages (account_id, thread_id, zalo_msg_id, sender_id, sender_name, direction, source, text, kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.accountId,
        event.threadId,
        event.messageId || null,
        event.senderId,
        event.displayName,
        event.isSelf ? "out" : "in",
        event.isSelf ? "owner" : "zalo",
        text,
        kind,
        event.receivedAt,
      );
    if (Number(res.changes) === 0) return false;
    const preview = text ?? describeNonText(event.msgType);
    this.touchConversation(event.threadId, event.threadType, preview, event.receivedAt, event.isSelf ? 0 : 1, opts.conversationName);
    return true;
  }

  recordOutbound(
    threadId: string,
    type: ThreadType,
    text: string,
    source: MessageSource,
    zaloMsgId: string | null,
    at = Date.now(),
    kind = "text",
    name?: string,
  ) {
    this.touchConversation(threadId, type, "", 0, 0, name);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO messages (account_id, thread_id, zalo_msg_id, sender_id, sender_name, direction, source, text, kind, created_at)
         VALUES (?, ?, ?, '', '', 'out', ?, ?, ?, ?)`,
      )
      .run(this.accountId, threadId, zaloMsgId, source, text, kind, at);
    this.touchConversation(threadId, type, text, at, 0, name);
  }

  conversations(limit = 500): ConversationRow[] {
    return this.db
      .prepare("SELECT * FROM conversations WHERE account_id = ? AND last_message_at > 0 ORDER BY last_message_at DESC LIMIT ?")
      .all(this.accountId, limit) as unknown as ConversationRow[];
  }

  /** Số đếm cho thanh bên: hội thoại còn tin chưa đọc, hội thoại đang chờ người thật. */
  counts(now = Date.now()): { unread: number; waitingHuman: number; waitingThreads: string[] } {
    const unread = (this.db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE account_id = ? AND unread > 0").get(this.accountId) as { n: number }).n;
    const rows = this.db.prepare("SELECT thread_id FROM conversations WHERE account_id = ? AND handoff_until > ?").all(this.accountId, now) as { thread_id: string }[];
    return { unread, waitingHuman: rows.length, waitingThreads: rows.map((r) => r.thread_id) };
  }

  /** Lúc tin đầu tiên của mỗi hội thoại ("Nhắn lần đầu"). */
  firstMessageTimes(): Map<string, number> {
    const rows = this.db
      .prepare("SELECT thread_id, MIN(created_at) AS t FROM messages WHERE account_id = ? GROUP BY thread_id")
      .all(this.accountId) as { thread_id: string; t: number }[];
    return new Map(rows.map((r) => [r.thread_id, Number(r.t)]));
  }

  conversation(threadId: string): ConversationRow | undefined {
    return this.db
      .prepare("SELECT * FROM conversations WHERE account_id = ? AND thread_id = ?")
      .get(this.accountId, threadId) as unknown as ConversationRow | undefined;
  }

  messages(threadId: string, limit = 100): MessageRow[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE account_id = ? AND thread_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(this.accountId, threadId, limit) as unknown as MessageRow[];
    return rows.reverse();
  }

  markRead(threadId: string) {
    this.db.prepare("UPDATE conversations SET unread = 0 WHERE account_id = ? AND thread_id = ?").run(this.accountId, threadId);
  }

  /** Lần cuối chủ tự gõ tay trong hội thoại (không tính tin lịch hẹn). */
  lastOwnerAt(threadId: string): number {
    const r = this.db
      .prepare("SELECT MAX(created_at) AS t FROM messages WHERE account_id = ? AND thread_id = ? AND source = 'owner' AND kind <> 'scheduled'")
      .get(this.accountId, threadId) as { t: number | null };
    return r?.t ?? 0;
  }

  setHandoff(threadId: string, until: number, reason: string) {
    this.db
      .prepare("UPDATE conversations SET handoff_until = ?, handoff_reason = ? WHERE account_id = ? AND thread_id = ?")
      .run(until, reason.slice(0, 300), this.accountId, threadId);
  }

  clearHandoff(threadId: string) {
    this.setHandoff(threadId, 0, "");
  }

  setNoProactive(threadId: string, value: boolean) {
    this.db.prepare("UPDATE conversations SET no_proactive = ? WHERE account_id = ? AND thread_id = ?").run(value ? 1 : 0, this.accountId, threadId);
  }

  /** Gắn tính cách trên trang quản trị: profileId, "off" (tắt bot), hoặc null (theo nhãn Zalo). */
  assign(threadIds: string[], value: number | "off" | null) {
    const stmt = this.db.prepare(
      "UPDATE conversations SET assigned_profile_id = ?, assigned_off = ? WHERE account_id = ? AND thread_id = ?",
    );
    for (const id of threadIds) {
      stmt.run(typeof value === "number" ? value : null, value === "off" ? 1 : 0, this.accountId, id);
    }
  }
}
