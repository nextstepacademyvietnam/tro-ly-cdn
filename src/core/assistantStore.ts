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
  /** "care" = tin chăm sóc chủ động, "schedule" = tin lịch gửi do AI soạn, "reply" = trả lời tin khách. */
  origin: "reply" | "care" | "schedule";
  /** Cách gửi khi duyệt (tin lịch gửi): tag tất cả, mức độ. */
  sendOpts: { mentionAll: boolean; urgency: 0 | 1 | 2 } | null;
  /** Lịch gửi sinh ra nháp (origin "schedule"). */
  scheduleId: number | null;
  /** Bản AI soạn ban đầu khi chủ đã sửa trước lúc gửi (null = gửi nguyên văn hoặc chưa gửi). */
  originalText: string | null;
}

export interface Notice {
  id: number;
  accountId: number;
  threadId: string;
  kind: "handoff" | "error" | "conflict" | "opt_out" | "command" | "group_stop" | "draft" | "update" | "mkt" | "care";
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
  origin: r.origin === "care" || r.origin === "schedule" ? r.origin : "reply",
  sendOpts: parseSendOpts(r.send_opts),
  scheduleId: r.schedule_id == null ? null : Number(r.schedule_id),
  originalText: r.original_text == null ? null : String(r.original_text),
});

function parseSendOpts(v: unknown): Draft["sendOpts"] {
  if (!v) return null;
  try {
    const o = JSON.parse(String(v)) as { mentionAll?: unknown; urgency?: unknown };
    const u = Number(o.urgency);
    return { mentionAll: Boolean(o.mentionAll), urgency: (u === 1 || u === 2 ? u : 0) as 0 | 1 | 2 };
  } catch {
    return null;
  }
}

/** Nháp chờ duyệt, thông báo cho chủ, cờ tạm dừng của tài khoản. */
export class AssistantStore {
  constructor(private readonly db: DB) {}

  // ---------- Nháp ----------
  /** Tạo nháp mới; nháp cũ còn chờ của cùng hội thoại coi như bị thay. */
  addDraft(
    accountId: number,
    threadId: string,
    profileId: number | null,
    text: string,
    handoff: boolean,
    now = Date.now(),
    origin: Draft["origin"] = "reply",
  ): Draft {
    this.supersede(accountId, threadId, now);
    const r = this.db
      .prepare("INSERT INTO drafts (account_id, thread_id, profile_id, text, handoff, created_at, origin) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(accountId, threadId, profileId, text, handoff ? 1 : 0, now, origin);
    return this.draft(Number(r.lastInsertRowid))!;
  }

  /**
   * Nháp tin lịch gửi do AI soạn: chỉ thay nháp cũ của CHÍNH lịch này trong hội thoại (lượt trước chưa duyệt),
   * không đụng nháp trả lời khách. Nhớ cách gửi (@All, mức độ) để lúc duyệt gửi đúng.
   */
  addScheduleDraft(
    accountId: number,
    threadId: string,
    profileId: number | null,
    text: string,
    scheduleId: number,
    sendOpts: { mentionAll: boolean; urgency: 0 | 1 | 2 },
    now = Date.now(),
  ): Draft {
    this.db
      .prepare("UPDATE drafts SET status = 'superseded', decided_at = ? WHERE account_id = ? AND thread_id = ? AND status = 'pending' AND schedule_id = ?")
      .run(now, accountId, threadId, scheduleId);
    const r = this.db
      .prepare(
        "INSERT INTO drafts (account_id, thread_id, profile_id, text, handoff, created_at, origin, send_opts, schedule_id) VALUES (?, ?, ?, ?, 0, ?, 'schedule', ?, ?)",
      )
      .run(accountId, threadId, profileId, text, now, JSON.stringify(sendOpts), scheduleId);
    return this.draft(Number(r.lastInsertRowid))!;
  }

  supersede(accountId: number, threadId: string, now = Date.now()) {
    this.db
      .prepare("UPDATE drafts SET status = 'superseded', decided_at = ? WHERE account_id = ? AND thread_id = ? AND status = 'pending' AND origin <> 'schedule'")
      .run(now, accountId, threadId);
  }

  /** Bỏ nháp còn chờ của một nguồn (VD nháp chăm sóc) soạn trước mốc `before` — khách đã nói chuyện tiếp. */
  supersedeOrigin(accountId: number, threadId: string, origin: Draft["origin"], before: number, now = Date.now()) {
    this.db
      .prepare(
        "UPDATE drafts SET status = 'superseded', decided_at = ? WHERE account_id = ? AND thread_id = ? AND status = 'pending' AND origin = ? AND created_at < ?",
      )
      .run(now, accountId, threadId, origin, before);
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

  /** Chủ duyệt / bỏ nháp. Gửi bản đã sửa thì giữ lại bản AI soạn gốc ở original_text (để học cách chủ viết). */
  decide(id: number, status: Exclude<DraftStatus, "pending">, error = "", text?: string, now = Date.now()) {
    const t = text ?? null;
    this.db
      .prepare(
        `UPDATE drafts SET status = ?, error = ?,
           original_text = CASE WHEN ? IS NOT NULL AND ? <> text THEN COALESCE(original_text, text) ELSE original_text END,
           text = COALESCE(?, text), decided_at = ? WHERE id = ?`,
      )
      .run(status, error.slice(0, 500), t, t, t, now, id);
  }

  /** Nháp đã quyết từ mốc `since`: gửi nguyên văn, chủ sửa rồi gửi, bỏ. */
  draftStats(accountId: number, since: number): { sentAsIs: number; edited: number; discarded: number } {
    const r = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'sent' AND original_text IS NULL THEN 1 ELSE 0 END) AS a,
           SUM(CASE WHEN status = 'sent' AND original_text IS NOT NULL THEN 1 ELSE 0 END) AS e,
           SUM(CASE WHEN status = 'discarded' THEN 1 ELSE 0 END) AS d
         FROM drafts WHERE account_id = ? AND decided_at >= ?`,
      )
      .get(accountId, since) as { a: number | null; e: number | null; d: number | null };
    return { sentAsIs: Number(r.a ?? 0), edited: Number(r.e ?? 0), discarded: Number(r.d ?? 0) };
  }

  /** Nháp chủ đã sửa rồi gửi (bản AI + bản chủ) — nguồn để học. */
  editedDrafts(accountId: number, since: number, limit = 40): Draft[] {
    return (
      this.db
        .prepare("SELECT * FROM drafts WHERE account_id = ? AND status = 'sent' AND original_text IS NOT NULL AND decided_at >= ? ORDER BY decided_at DESC LIMIT ?")
        .all(accountId, since, limit) as Record<string, unknown>[]
    ).map(toDraft);
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
