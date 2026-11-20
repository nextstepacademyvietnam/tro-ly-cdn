import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DB } from "../server/db.js";
import { type Recurrence, RecurrenceError, nextRun, validateRecurrence } from "./recurrence.js";

export type ScheduleStatus = "active" | "paused" | "cancelled" | "done";
export type RunStatus = "sent" | "failed" | "missed" | "drafted";
/** "off" = gửi đúng nội dung soạn sẵn; "draft" = mỗi lượt AI viết tin mới, chờ chủ duyệt; "auto" = AI viết và tự gửi. */
export type AiMode = "off" | "draft" | "auto";

export interface ScheduleTarget {
  threadId: string;
  threadType: "user" | "group";
  name: string;
}

export interface ScheduleInput {
  /** Tài khoản Zalo gửi lịch này (mặc định 1). */
  accountId?: number;
  title?: string;
  text: string;
  imageIds: number[];
  targets: ScheduleTarget[];
  recurrence: Recurrence;
  /** Tag tất cả mọi người (@All) — chỉ có tác dụng khi gửi vào nhóm. */
  mentionAll?: boolean;
  /** Mức độ tin: 0 thường, 1 quan trọng, 2 khẩn cấp. */
  urgency?: Urgency;
  aiMode?: AiMode;
  /** Chủ đề / yêu cầu cho AI (bắt buộc khi aiMode khác off). */
  aiBrief?: string;
  /** Tính cách AI dùng để viết (null = tính cách đầu tiên của tài khoản). */
  aiProfileId?: number | null;
}

export type Urgency = 0 | 1 | 2;

export interface Schedule extends Omit<ScheduleInput, "title" | "accountId" | "mentionAll" | "urgency" | "aiMode" | "aiBrief" | "aiProfileId"> {
  id: number;
  mentionAll: boolean;
  urgency: Urgency;
  aiMode: AiMode;
  aiBrief: string;
  aiProfileId: number | null;
  accountId: number;
  title: string;
  status: ScheduleStatus;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ScheduleRun {
  id: number;
  scheduleId: number;
  threadId: string;
  plannedAt: number;
  status: RunStatus;
  error: string;
  doneAt: number;
  manual: boolean;
  /** Nội dung đã gửi / đã soạn của lượt (lịch AI soạn). */
  text?: string;
}

export interface MediaRow {
  id: number;
  file: string;
  name: string;
  mime: string;
  bytes: number;
}

export const MAX_IMAGES = 10;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

export class ScheduleError extends Error {}

interface ScheduleRow {
  id: number;
  account_id: number;
  title: string;
  text: string;
  image_ids: string;
  recurrence: string;
  status: ScheduleStatus;
  next_run_at: number | null;
  mention_all: number;
  urgency: number;
  ai_mode: string;
  ai_brief: string;
  ai_profile_id: number | null;
  created_at: number;
  updated_at: number;
}

export class ScheduleStore {
  readonly mediaDir: string;

  constructor(private readonly db: DB, dataDir: string) {
    this.mediaDir = path.join(dataDir, "media");
  }

  // ---------- Ảnh ----------
  saveImage(name: string, data: Buffer): MediaRow {
    const ext = path.extname(name).slice(1).toLowerCase();
    const mime = IMAGE_TYPES[ext];
    if (!mime) throw new ScheduleError("Chỉ nhận ảnh JPG, PNG, WebP");
    if (data.length > MAX_IMAGE_BYTES) throw new ScheduleError("Ảnh quá lớn (tối đa 10 MB)");
    if (data.length < 8) throw new ScheduleError("File ảnh hỏng");
    fs.mkdirSync(this.mediaDir, { recursive: true });
    const file = `${crypto.randomUUID()}.${ext === "jpeg" ? "jpg" : ext}`;
    fs.writeFileSync(path.join(this.mediaDir, file), data);
    const cleanName = name.split(/[\\/]/).pop()!.slice(0, 200);
    const r = this.db
      .prepare("INSERT INTO media (file, name, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(file, cleanName, mime, data.length, Date.now());
    return { id: Number(r.lastInsertRowid), file, name: cleanName, mime, bytes: data.length };
  }

  media(id: number): MediaRow | undefined {
    return this.db.prepare("SELECT id, file, name, mime, bytes FROM media WHERE id = ?").get(id) as MediaRow | undefined;
  }

  mediaPath(m: MediaRow): string {
    return path.join(this.mediaDir, m.file);
  }

  // ---------- Lịch ----------
  private validate(input: ScheduleInput, now: number, isNew: boolean): number | null {
    const text = (input.text ?? "").trim();
    const imageIds = input.imageIds ?? [];
    const ai = input.aiMode ?? "off";
    if (!["off", "draft", "auto"].includes(ai)) throw new ScheduleError("Cách soạn tin không hợp lệ");
    if (ai !== "off") {
      if (!(input.aiBrief ?? "").trim()) throw new ScheduleError("Nhập chủ đề để AI soạn tin mỗi lượt");
      if ((input.aiBrief ?? "").length > 3000) throw new ScheduleError("Chủ đề quá dài (tối đa 3000 ký tự)");
      if (imageIds.length) throw new ScheduleError("Lịch AI soạn chưa kèm được ảnh — bỏ ảnh hoặc chuyển về tự soạn");
    } else if (!text && imageIds.length === 0) throw new ScheduleError("Lịch cần có chữ hoặc ảnh");
    if (text.length > 6000) throw new ScheduleError("Nội dung quá dài (tối đa 6000 ký tự)");
    if (imageIds.length > MAX_IMAGES) throw new ScheduleError(`Tối đa ${MAX_IMAGES} ảnh`);
    for (const id of imageIds) if (!this.media(id)) throw new ScheduleError("Có ảnh không còn tồn tại, hãy tải lại");
    if (!input.targets?.length) throw new ScheduleError("Chọn ít nhất một hội thoại để gửi");
    if (input.urgency !== undefined && ![0, 1, 2].includes(Number(input.urgency))) throw new ScheduleError("Mức độ tin không hợp lệ");
    try {
      validateRecurrence(input.recurrence);
    } catch (err) {
      if (err instanceof RecurrenceError) throw new ScheduleError(err.message);
      throw err;
    }
    const next = nextRun(input.recurrence, now);
    if (next === null && isNew) throw new ScheduleError("Thời điểm gửi đã qua — chọn ngày giờ trong tương lai");
    return next;
  }

  create(input: ScheduleInput, now = Date.now()): Schedule {
    const next = this.validate(input, now, true);
    this.db.exec("BEGIN");
    try {
      const r = this.db
        .prepare(
          `INSERT INTO schedules (account_id, title, text, image_ids, recurrence, status, next_run_at, mention_all, urgency, ai_mode, ai_brief, ai_profile_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(input.accountId ?? 1, (input.title ?? "").trim().slice(0, 120), input.text.trim(), JSON.stringify(input.imageIds), JSON.stringify(input.recurrence), next, input.mentionAll ? 1 : 0, Number(input.urgency ?? 0), ...aiCols(input), now, now);
      const id = Number(r.lastInsertRowid);
      this.writeTargets(id, input.targets);
      this.db.exec("COMMIT");
      return this.get(id)!;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  update(id: number, input: ScheduleInput, now = Date.now()): Schedule {
    const current = this.get(id);
    if (!current) throw new ScheduleError("Không có lịch này");
    if (current.status === "cancelled") throw new ScheduleError("Lịch đã huỷ, hãy nhân bản để tạo lịch mới");
    const next = this.validate(input, now, false);
    // Sửa lịch đã hoàn tất mà có lượt mới trong tương lai thì chạy lại.
    const status: ScheduleStatus = next === null ? "done" : current.status === "done" ? "active" : current.status;
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("UPDATE schedules SET title = ?, text = ?, image_ids = ?, recurrence = ?, status = ?, next_run_at = ?, mention_all = ?, urgency = ?, ai_mode = ?, ai_brief = ?, ai_profile_id = ?, updated_at = ? WHERE id = ?")
        .run(
          (input.title ?? "").trim().slice(0, 120),
          input.text.trim(),
          JSON.stringify(input.imageIds),
          JSON.stringify(input.recurrence),
          status,
          next,
          input.mentionAll ? 1 : 0,
          Number(input.urgency ?? 0),
          ...aiCols(input),
          now,
          id,
        );
      this.db.prepare("DELETE FROM schedule_targets WHERE schedule_id = ?").run(id);
      this.writeTargets(id, input.targets);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.get(id)!;
  }

  private writeTargets(id: number, targets: ScheduleTarget[]) {
    const stmt = this.db.prepare("INSERT OR IGNORE INTO schedule_targets (schedule_id, thread_id, thread_type, name) VALUES (?, ?, ?, ?)");
    for (const t of targets) {
      if (!t.threadId || (t.threadType !== "user" && t.threadType !== "group")) throw new ScheduleError("Hội thoại không hợp lệ");
      stmt.run(id, String(t.threadId), t.threadType, String(t.name ?? "").slice(0, 200));
    }
  }

  setStatus(id: number, status: ScheduleStatus, now = Date.now()): Schedule {
    const s = this.get(id);
    if (!s) throw new ScheduleError("Không có lịch này");
    if (s.status === "cancelled" && status !== "cancelled") throw new ScheduleError("Lịch đã huỷ không chạy lại được");
    let next = s.nextRunAt;
    if (status === "active") {
      // Chạy lại sau tạm dừng: bỏ qua các lượt đã trôi qua lúc dừng.
      next = nextRun(s.recurrence, now);
      if (next === null) status = "done";
    }
    this.db.prepare("UPDATE schedules SET status = ?, next_run_at = ?, updated_at = ? WHERE id = ?").run(status, next, now, id);
    return this.get(id)!;
  }

  remove(id: number): void {
    this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
  }

  duplicate(id: number, now = Date.now()): Schedule {
    const s = this.get(id);
    if (!s) throw new ScheduleError("Không có lịch này");
    const rec = { ...s.recurrence };
    // Lịch một lần đã qua thì dời sang ngày mai cùng giờ để lưu được.
    if (nextRun(rec, now) === null) {
      rec.date = new Date(now + 7 * 3_600_000 + 86_400_000).toISOString().slice(0, 10);
      if (rec.endDate && rec.endDate < rec.date) delete rec.endDate;
    }
    return this.create({ accountId: s.accountId, title: s.title ? `${s.title} (bản sao)` : "", text: s.text, imageIds: s.imageIds, targets: s.targets, recurrence: rec, mentionAll: s.mentionAll, urgency: s.urgency, aiMode: s.aiMode, aiBrief: s.aiBrief, aiProfileId: s.aiProfileId }, now);
  }

  get(id: number): Schedule | undefined {
    const row = this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as ScheduleRow | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  list(filter: { accountId?: number; threadId?: string; status?: ScheduleStatus } = {}): Schedule[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.accountId !== undefined) {
      where.push("account_id = ?");
      args.push(filter.accountId);
    }
    if (filter.threadId) {
      where.push("id IN (SELECT schedule_id FROM schedule_targets WHERE thread_id = ?)");
      args.push(filter.threadId);
    }
    if (filter.status) {
      where.push("status = ?");
      args.push(filter.status);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM schedules ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
                  COALESCE(next_run_at, 9e15), updated_at DESC`,
      )
      .all(...args) as unknown as ScheduleRow[];
    return rows.map((r) => this.hydrate(r));
  }

  due(now: number): Schedule[] {
    const rows = this.db
      .prepare("SELECT * FROM schedules WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at")
      .all(now) as unknown as ScheduleRow[];
    return rows.map((r) => this.hydrate(r));
  }

  /** Sang lượt kế tiếp sau `plannedAt`; hết lượt thì "done". */
  advance(id: number, plannedAt: number, now = Date.now()): void {
    const s = this.get(id);
    if (!s || s.status !== "active") return;
    const next = nextRun(s.recurrence, Math.max(plannedAt, now - 60_000));
    this.db
      .prepare("UPDATE schedules SET next_run_at = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(next, next === null ? "done" : "active", now, id);
  }

  private hydrate(row: ScheduleRow): Schedule {
    const targets = (
      this.db.prepare("SELECT thread_id, thread_type, name FROM schedule_targets WHERE schedule_id = ? ORDER BY rowid").all(row.id) as {
        thread_id: string;
        thread_type: "user" | "group";
        name: string;
      }[]
    ).map((t) => ({ threadId: t.thread_id, threadType: t.thread_type, name: t.name }));
    return {
      id: row.id,
      accountId: row.account_id ?? 1,
      title: row.title,
      text: row.text,
      imageIds: JSON.parse(row.image_ids) as number[],
      recurrence: JSON.parse(row.recurrence) as Recurrence,
      status: row.status,
      nextRunAt: row.next_run_at,
      mentionAll: Boolean(row.mention_all),
      urgency: (Number(row.urgency) || 0) as Urgency,
      aiMode: (["draft", "auto"].includes(row.ai_mode) ? row.ai_mode : "off") as AiMode,
      aiBrief: row.ai_brief ?? "",
      aiProfileId: row.ai_profile_id ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      targets,
    };
  }

  // ---------- Lượt gửi ----------
  addRun(run: Omit<ScheduleRun, "id">): number {
    const r = this.db
      .prepare("INSERT INTO schedule_runs (schedule_id, thread_id, planned_at, status, error, done_at, manual, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(run.scheduleId, run.threadId, run.plannedAt, run.status, run.error.slice(0, 500), run.doneAt, run.manual ? 1 : 0, (run.text ?? "").slice(0, 6000));
    return Number(r.lastInsertRowid);
  }

  updateRun(id: number, status: RunStatus, error: string, doneAt = Date.now()): void {
    this.db.prepare("UPDATE schedule_runs SET status = ?, error = ?, done_at = ? WHERE id = ?").run(status, error.slice(0, 500), doneAt, id);
  }

  run(id: number): ScheduleRun | undefined {
    const r = this.db.prepare("SELECT * FROM schedule_runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? toRun(r) : undefined;
  }

  /** Các tin AI đã viết gần đây cho lịch này (mới nhất trước, không trùng) — để AI không lặp lại. */
  recentTexts(scheduleId: number, limit = 5): string[] {
    const rows = this.db
      .prepare("SELECT text FROM schedule_runs WHERE schedule_id = ? AND text <> '' GROUP BY text ORDER BY MAX(done_at) DESC LIMIT ?")
      .all(scheduleId, limit) as { text: string }[];
    return rows.map((r) => r.text);
  }

  runs(scheduleId: number, limit = 50): ScheduleRun[] {
    return (
      this.db.prepare("SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY done_at DESC, id DESC LIMIT ?").all(scheduleId, limit) as Record<
        string,
        unknown
      >[]
    ).map(toRun);
  }
}

function toRun(r: Record<string, unknown>): ScheduleRun {
  return {
    id: Number(r.id),
    scheduleId: Number(r.schedule_id),
    threadId: String(r.thread_id),
    plannedAt: Number(r.planned_at),
    status: r.status as RunStatus,
    error: String(r.error ?? ""),
    doneAt: Number(r.done_at),
    manual: Boolean(r.manual),
    text: String(r.text ?? ""),
  };
}

function aiCols(input: ScheduleInput): [string, string, number | null] {
  const mode = input.aiMode ?? "off";
  return [mode, mode === "off" ? "" : (input.aiBrief ?? "").trim(), input.aiProfileId ? Number(input.aiProfileId) : null];
}
