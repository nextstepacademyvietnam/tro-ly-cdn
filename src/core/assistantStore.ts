import type { DB } from "../server/db.js";

export type DraftStatus = "pending" | "sent" | "discarded" | "superseded" | "failed";

export interface Draft {
  id: number;
  accountId: number;
  threadId: string;
  profileId: number | null;
  text: string;
  handoff: boolean;
  status: DraftStatus;
  error: string;
  createdAt: number;
  decidedAt: number | null;
}

export interface Notice {
  id: number;
  accountId: number;
  threadId: string;
  kind: "handoff" | "error" | "conflict" | "opt_out" | "command" | "group_stop" | "draft" | "update";
  text: string;
  createdAt: number;
  read: boolean;
}

const toDraft = (r: Record<string, unknown>): Draft => ({
  id: Number(r.id),
  accountId: Number(r.account_id),
  threadId: String(r.thread_id),
  profileId: r.profile_id === null ? null : Number(r.profile_id),
  text: String(r.text),
  handoff: Boolean(r.handoff),
  status: r.status as DraftStatus,
  error: String(r.error ?? ""),
  createdAt: Number(r.created_at),
  decidedAt: r.decided_at === null ? null : Number(r.decided_at),
});

/** Nháp chờ duyệt, thông báo cho chủ, cờ tạm dừng của tài khoản. */
export class AssistantStore {
  constructor(private readonly db: DB) {}

  // ---------- Nháp ----------
  /** Tạo nháp mới; nháp cũ còn chờ của cùng hội thoại coi như bị thay. */
  addDraft(accountId: number, threadId: string, profileId: number | null, text: string, handoff: boolean, now = Date.now()): Draft {
    this.supersede(accountId, threadId, now);
    const r = this.db
      .prepare("INSERT INTO drafts (account_id, thread_id, profile_id, text, handoff, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(accountId, threadId, profileId, text, handoff ? 1 : 0, now);
    return this.draft(Number(r.lastInsertRowid))!;
  }

  supersede(accountId: number, threadId: string, now = Date.now()) {
    this.db
      .prepare("UPDATE drafts SET status = 'superseded', decided_at = ? WHERE account_id = ? AND thread_id = ? AND status = 'pending'")
      .run(now, accountId, threadId);
  }

  draft(id: number): Draft | undefined {
    const r = this.db.prepare("SELECT * FROM drafts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? toDraft(r) : undefined;
  }

  pending(accountId: number, threadId?: string): Draft[] {
    const rows = threadId
      ? this.db.prepare("SELECT * FROM drafts WHERE account_id = ? AND thread_id = ? AND status = 'pending' ORDER BY id").all(accountId, threadId)
      : this.db.prepare("SELECT * FROM drafts WHERE account_id = ? AND status = 'pending' ORDER BY id").all(accountId);
    return (rows as Record<string, unknown>[]).map(toDraft);
  }

  pendingCounts(accountId: number): Map<string, number> {
    const rows = this.db
      .prepare("SELECT thread_id, COUNT(*) AS n FROM drafts WHERE account_id = ? AND status = 'pending' GROUP BY thread_id")
      .all(accountId) as { thread_id: string; n: number }[];
    return new Map(rows.map((r) => [r.thread_id, r.n]));
  }

  /** Nháp cũ nhất còn chờ của mỗi hội thoại — để tính "chờ bao lâu". */
  pendingSince(accountId: number): Map<string, number> {
    const rows = this.db
      .prepare("SELECT thread_id, MIN(created_at) AS t FROM drafts WHERE account_id = ? AND status = 'pending' GROUP BY thread_id")
      .all(accountId) as { thread_id: string; t: number }[];
    return new Map(rows.map((r) => [r.thread_id, Number(r.t)]));
  }

  decide(id: number, status: Exclude<DraftStatus, "pending">, error = "", text?: string) {
    this.db
      .prepare("UPDATE drafts SET status = ?, error = ?, text = COALESCE(?, text), decided_at = ? WHERE id = ?")
      .run(status, error.slice(0, 500), text ?? null, Date.now(), id);
  }

  // ---------- Thông báo ----------
  notify(accountId: number, kind: Notice["kind"], text: string, threadId = "", now = Date.now()) {
    this.db
      .prepare("INSERT INTO notifications (account_id, thread_id, kind, text, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(accountId, threadId, kind, text.slice(0, 1000), now);
  }

  notices(accountId: number, limit = 50): Notice[] {
    return (
      this.db.prepare("SELECT * FROM notifications WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(accountId, limit) as Record<
        string,
        unknown
      >[]
    ).map((r) => ({
      id: Number(r.id),
      accountId: Number(r.account_id),
      threadId: String(r.thread_id),
      kind: r.kind as Notice["kind"],
      text: String(r.text),
      createdAt: Number(r.created_at),
      read: Boolean(r.read),
    }));
  }

  unreadCount(accountId: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE account_id = ? AND read = 0").get(accountId) as { n: number }).n;
  }

  markAllRead(accountId: number) {
    this.db.prepare("UPDATE notifications SET read = 1 WHERE account_id = ?").run(accountId);
  }

  // ---------- Tạm dừng toàn bộ ----------
  isPaused(accountId: number): boolean {
    const r = this.db.prepare("SELECT paused FROM accounts WHERE id = ?").get(accountId) as { paused: number } | undefined;
    return Boolean(r?.paused);
  }

  setPaused(accountId: number, paused: boolean) {
    this.db.prepare("UPDATE accounts SET paused = ? WHERE id = ?").run(paused ? 1 : 0, accountId);
  }
}
