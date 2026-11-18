import type { DB } from "../server/db.js";
import { type CarePlanUpdate, type PlanSnapshot, MAX_EVERY_DAYS, MIN_EVERY_DAYS, vnDay } from "./prompt.js";

export type CareStatus = "active" | "paused" | "stopped";
export type CareLogKind = "analyze" | "draft" | "sent" | "skip" | "edit" | "stop" | "error";

export interface CarePlan {
  accountId: number;
  threadId: string;
  profileId: number | null;
  status: CareStatus;
  stage: string;
  facts: string;
  summary: string;
  needs: string;
  goal: string;
  everyDays: number;
  nextAt: number | null;
  reason: string;
  stopReason: string;
  locked: boolean;
  analyzedAt: number;
  lastCareAt: number;
  careCount: number;
  updatedAt: number;
}

export interface CareLogEntry {
  id: number;
  kind: CareLogKind;
  text: string;
  at: number;
}

type Row = Record<string, unknown>;
const toPlan = (r: Row): CarePlan => ({
  accountId: Number(r.account_id),
  threadId: String(r.thread_id),
  profileId: r.profile_id === null ? null : Number(r.profile_id),
  status: r.status as CareStatus,
  stage: String(r.stage),
  facts: String(r.facts),
  summary: String(r.summary),
  needs: String(r.needs),
  goal: String(r.goal),
  everyDays: Number(r.every_days),
  nextAt: r.next_at === null ? null : Number(r.next_at),
  reason: String(r.reason),
  stopReason: String(r.stop_reason),
  locked: Boolean(r.locked),
  analyzedAt: Number(r.analyzed_at),
  lastCareAt: Number(r.last_care_at),
  careCount: Number(r.care_count),
  updatedAt: Number(r.updated_at),
});

/** Bản tóm gọn của kế hoạch để đưa vào lời dặn AI. */
export const snapshot = (p: CarePlan): PlanSnapshot => ({
  stage: p.stage,
  facts: p.facts,
  summary: p.summary,
  needs: p.needs,
  goal: p.goal,
  everyDays: p.everyDays,
  nextDay: p.nextAt ? vnDay(p.nextAt) : "",
  locked: p.locked,
  careCount: p.careCount,
  lastCareDay: p.lastCareAt ? vnDay(p.lastCareAt) : "",
});

/** Hồ sơ + kế hoạch chăm sóc từng khách, lịch sử chăm sóc. */
export class CareStore {
  constructor(private readonly db: DB) {}

  get(accountId: number, threadId: string): CarePlan | undefined {
    const r = this.db.prepare("SELECT * FROM care_plans WHERE account_id = ? AND thread_id = ?").get(accountId, threadId) as Row | undefined;
    return r ? toPlan(r) : undefined;
  }

  list(accountId: number): CarePlan[] {
    return (this.db.prepare("SELECT * FROM care_plans WHERE account_id = ? ORDER BY next_at IS NULL, next_at").all(accountId) as Row[]).map(toPlan);
  }

  /** Kế hoạch đang chạy đã tới giờ, cũ trước. */
  due(now: number, limit = 20): CarePlan[] {
    return (
      this.db.prepare("SELECT * FROM care_plans WHERE status = 'active' AND next_at IS NOT NULL AND next_at <= ? ORDER BY next_at LIMIT ?").all(now, limit) as Row[]
    ).map(toPlan);
  }

  /** Số khách tới hạn trong ngày (giờ VN) — số đếm ở menu. */
  dueToday(accountId: number, now: number): number {
    const end = Date.parse(`${vnDay(now)}T00:00:00Z`) - 7 * 3_600_000 + 86_400_000;
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM care_plans WHERE account_id = ? AND status = 'active' AND next_at IS NOT NULL AND next_at < ?").get(accountId, end) as {
        n: number;
      }
    ).n;
  }

  /** Ghi kết quả phân tích của AI. Kế hoạch khoá thì giữ lịch của chủ. */
  applyAnalysis(accountId: number, threadId: string, profileId: number, u: CarePlanUpdate, nextAt: number | null, now: number): CarePlan {
    const cur = this.get(accountId, threadId);
    const locked = cur?.locked ?? false;
    const stop = Boolean(u.stop) && !locked;
    const everyDays = locked ? cur!.everyDays : (u.everyDays ?? cur?.everyDays ?? 3);
    const next = locked ? (cur!.nextAt ?? nextAt) : nextAt;
    // Chủ đã tạm dừng / dừng thì AI không tự bật lại; AI đề nghị dừng thì dừng.
    const status: CareStatus = stop ? "stopped" : (cur?.status ?? "active");
    this.db
      .prepare(
        `INSERT INTO care_plans (account_id, thread_id, profile_id, status, stage, facts, summary, needs, goal, every_days, next_at, reason, stop_reason, locked, analyzed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(account_id, thread_id) DO UPDATE SET
           profile_id = excluded.profile_id, status = excluded.status, stage = excluded.stage, facts = excluded.facts,
           summary = excluded.summary, needs = excluded.needs, goal = excluded.goal, every_days = excluded.every_days,
           next_at = excluded.next_at, reason = excluded.reason, stop_reason = excluded.stop_reason,
           analyzed_at = excluded.analyzed_at, updated_at = excluded.updated_at`,
      )
      .run(
        accountId,
        threadId,
        profileId,
        status,
        u.stage || cur?.stage || "",
        u.facts || cur?.facts || "",
        u.summary || cur?.summary || "",
        u.needs || cur?.needs || "",
        stop ? "" : u.goal || cur?.goal || "",
        Math.min(MAX_EVERY_DAYS, Math.max(MIN_EVERY_DAYS, everyDays)),
        stop ? null : next,
        locked ? cur!.reason : u.reason || cur?.reason || "",
        stop ? u.stop : "",
        now,
        now,
      );
    return this.get(accountId, threadId)!;
  }

  /** Chủ sửa tay: hồ sơ, lịch, khoá, trạng thái. */
  edit(
    accountId: number,
    threadId: string,
    patch: Partial<Pick<CarePlan, "facts" | "summary" | "needs" | "goal" | "stage" | "everyDays" | "nextAt" | "locked" | "status">>,
    now: number,
  ): CarePlan {
    const cur = this.get(accountId, threadId);
    if (!cur) throw new Error("Khách này chưa có kế hoạch chăm sóc");
    const p = { ...cur, ...patch };
    p.everyDays = Math.min(MAX_EVERY_DAYS, Math.max(MIN_EVERY_DAYS, Math.round(Number(p.everyDays)) || cur.everyDays));
    this.db
      .prepare(
        `UPDATE care_plans SET status = ?, stage = ?, facts = ?, summary = ?, needs = ?, goal = ?, every_days = ?, next_at = ?, locked = ?,
           stop_reason = CASE WHEN ? = 'stopped' THEN stop_reason ELSE '' END, updated_at = ?
         WHERE account_id = ? AND thread_id = ?`,
      )
      .run(p.status, p.stage, p.facts, p.summary, p.needs, p.goal, p.everyDays, p.nextAt, p.locked ? 1 : 0, p.status, now, accountId, threadId);
    return this.get(accountId, threadId)!;
  }

  /** Dời lần tới (không ghi đè lịch chủ khoá trừ khi `force`). */
  reschedule(accountId: number, threadId: string, nextAt: number, now: number) {
    this.db.prepare("UPDATE care_plans SET next_at = ?, updated_at = ? WHERE account_id = ? AND thread_id = ?").run(nextAt, now, accountId, threadId);
  }

  markSent(accountId: number, threadId: string, now: number) {
    this.db
      .prepare("UPDATE care_plans SET last_care_at = ?, care_count = care_count + 1, updated_at = ? WHERE account_id = ? AND thread_id = ?")
      .run(now, now, accountId, threadId);
  }

  /** Số tin chăm sóc đã soạn hôm nay (giờ VN) của các khách thuộc một tính cách. */
  draftedToday(accountId: number, profileId: number, now: number): number {
    const start = Date.parse(`${vnDay(now)}T00:00:00Z`) - 7 * 3_600_000;
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM care_log l JOIN care_plans p ON p.account_id = l.account_id AND p.thread_id = l.thread_id
           WHERE l.account_id = ? AND p.profile_id = ? AND l.kind = 'draft' AND l.at >= ?`,
        )
        .get(accountId, profileId, start) as { n: number }
    ).n;
  }

  log(accountId: number, threadId: string, kind: CareLogKind, text: string, at: number) {
    this.db.prepare("INSERT INTO care_log (account_id, thread_id, kind, text, at) VALUES (?, ?, ?, ?, ?)").run(accountId, threadId, kind, text.slice(0, 1000), at);
  }

  history(accountId: number, threadId: string, limit = 20): CareLogEntry[] {
    return (
      this.db.prepare("SELECT id, kind, text, at FROM care_log WHERE account_id = ? AND thread_id = ? ORDER BY at DESC, id DESC LIMIT ?").all(accountId, threadId, limit) as Row[]
    ).map((r) => ({ id: Number(r.id), kind: r.kind as CareLogKind, text: String(r.text), at: Number(r.at) }));
  }

  /** Lúc phân tích gần nhất của mọi khách một tài khoản (để tìm hội thoại có tin mới). */
  analyzedTimes(accountId: number): Map<string, number> {
    const rows = this.db.prepare("SELECT thread_id, analyzed_at FROM care_plans WHERE account_id = ?").all(accountId) as { thread_id: string; analyzed_at: number }[];
    return new Map(rows.map((r) => [r.thread_id, Number(r.analyzed_at)]));
  }
}
