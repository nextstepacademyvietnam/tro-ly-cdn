import type { DB } from "../server/db.js";
import type { GroupChange } from "../channels/zalo/groupEvents.js";
import type { GroupDetail } from "../channels/zalo/channel.js";
import {
  type Bucket,
  type EventRow,
  type WelcomeConfig,
  afterQuiet,
  computeStats,
  diffMembers,
  pickTemplate,
  planPrivateSlot,
  renderWelcome,
  sanitizeWelcome,
} from "./logic.js";

/** Những gì bộ theo dõi nhóm cần từ một tài khoản Zalo (thay được bằng đồ giả khi test). */
export interface GroupChannel {
  isConnected(): boolean;
  ownId(): string;
  groups(): Promise<{ id: string; name: string; memberCount: number; isAdmin: boolean }[]>;
  groupDetail(groupId: string): Promise<GroupDetail>;
  memberNames(ids: string[]): Promise<Map<string, string>>;
  sendMention(groupId: string, text: string, mentions: { pos: number; uid: string; len: number }[]): Promise<string | null>;
  sendText(userId: string, text: string): Promise<string[]>;
  sendImages(threadId: string, type: "user" | "group", paths: string[]): Promise<string[]>;
  recordOutbound(threadId: string, type: "user" | "group", text: string, msgId: string | null, name?: string): void;
}

export interface GroupTrackerDeps {
  channel(accountId: number): GroupChannel | undefined;
  accountIds(): number[];
  isPaused(accountId: number): boolean;
  mediaPath(id: number): string | null;
  log?: (msg: string, extra?: object) => void;
  rand?: () => number;
}

export interface TrackedGroup {
  account_id: number;
  group_id: string;
  name: string;
  member_count: number;
  tracked_at: number;
  reconciled_at: number;
  welcome: string;
}

export interface WelcomeRow {
  id: number;
  account_id: number;
  group_id: string;
  kind: "group" | "private";
  members: string;
  status: "pending" | "sent" | "skipped" | "failed";
  due_at: number;
  done_at: number | null;
  text: string;
  error: string;
  created_at: number;
}

type Member = { id: string; name: string; actorName?: string };
const LATE_MS = 6 * 3_600_000;
export const TICK_MS = 15_000;
export const RECONCILE_EVERY_MS = 6 * 3_600_000;

/**
 * Theo dõi nhóm Zalo: ghi ai vào/rời (sự kiện tức thời + đối chiếu danh sách định kỳ),
 * tính thống kê, và chạy luồng chào mừng (chào trong nhóm gom theo đợt, chào riêng có giới hạn).
 */
export class GroupTracker {
  private timer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private ticking = false;
  /** Chủ / phó nhóm theo từng nhóm, để không chào họ. */
  private readonly admins = new Map<string, Set<string>>();

  constructor(
    private readonly db: DB,
    private readonly deps: GroupTrackerDeps,
  ) {}

  private get rand() {
    return this.deps.rand ?? Math.random;
  }

  // ---------- Nhóm theo dõi ----------

  tracked(accountId: number): TrackedGroup[] {
    return this.db.prepare("SELECT * FROM tracked_groups WHERE account_id = ? ORDER BY name").all(accountId) as unknown as TrackedGroup[];
  }

  group(accountId: number, groupId: string): TrackedGroup | undefined {
    return this.db.prepare("SELECT * FROM tracked_groups WHERE account_id = ? AND group_id = ?").get(accountId, groupId) as unknown as TrackedGroup | undefined;
  }

  /** Quét: mọi nhóm nick đang ở, đánh dấu nhóm nào đã theo dõi. */
  async scan(accountId: number) {
    const ch = this.requireChannel(accountId);
    const tracked = new Set(this.tracked(accountId).map((g) => g.group_id));
    return (await ch.groups()).map((g) => ({ ...g, tracked: tracked.has(g.id) }));
  }

  /** Bắt đầu theo dõi: chụp danh sách thành viên hiện tại làm mốc (không tính là "vào mới"). */
  async track(accountId: number, groupId: string, now = Date.now()): Promise<TrackedGroup> {
    const existing = this.group(accountId, groupId);
    if (existing) return existing;
    const ch = this.requireChannel(accountId);
    const detail = await ch.groupDetail(groupId);
    const names = await ch.memberNames(detail.memberIds);
    this.admins.set(`${accountId}:${groupId}`, new Set([...detail.adminIds, detail.creatorId].filter(Boolean)));
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("INSERT INTO tracked_groups (account_id, group_id, name, member_count, tracked_at, reconciled_at, welcome) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(accountId, groupId, detail.name, detail.totalMember || detail.memberIds.length, now, now, JSON.stringify(sanitizeWelcome({})));
      const ins = this.db.prepare("INSERT INTO group_members (account_id, group_id, user_id, name, present, first_seen_at) VALUES (?, ?, ?, ?, 1, ?)");
      for (const id of detail.memberIds) ins.run(accountId, groupId, id, names.get(id) ?? "", now);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.group(accountId, groupId)!;
  }

  /** Thôi theo dõi: xoá luôn số liệu và hàng đợi lời chào của nhóm. */
  untrack(accountId: number, groupId: string) {
    this.db.prepare("DELETE FROM tracked_groups WHERE account_id = ? AND group_id = ?").run(accountId, groupId);
    this.admins.delete(`${accountId}:${groupId}`);
  }

  // ---------- Ghi nhận vào / rời ----------

  private presentIds(accountId: number, groupId: string): string[] {
    return (
      this.db.prepare("SELECT user_id FROM group_members WHERE account_id = ? AND group_id = ? AND present = 1").all(accountId, groupId) as { user_id: string }[]
    ).map((r) => r.user_id);
  }

  private isPresent(accountId: number, groupId: string, userId: string): boolean {
    const r = this.db.prepare("SELECT present FROM group_members WHERE account_id = ? AND group_id = ? AND user_id = ?").get(accountId, groupId, userId) as
      | { present: number }
      | undefined;
    return r?.present === 1;
  }

  private markJoin(accountId: number, groupId: string, m: Member, at: number) {
    this.db
      .prepare(
        `INSERT INTO group_members (account_id, group_id, user_id, name, present, first_seen_at, joined_at) VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT (account_id, group_id, user_id) DO UPDATE SET present = 1, joined_at = excluded.joined_at, left_at = NULL,
           name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE group_members.name END`,
      )
      .run(accountId, groupId, m.id, m.name, at, at);
  }

  private markLeave(accountId: number, groupId: string, m: Member, at: number) {
    this.db
      .prepare(
        `INSERT INTO group_members (account_id, group_id, user_id, name, present, first_seen_at, left_at) VALUES (?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT (account_id, group_id, user_id) DO UPDATE SET present = 0, left_at = excluded.left_at,
           name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE group_members.name END`,
      )
      .run(accountId, groupId, m.id, m.name, at, at);
  }

  private addEvent(accountId: number, groupId: string, e: Omit<EventRow, "at"> & { at: number }) {
    this.db
      .prepare("INSERT INTO group_events (account_id, group_id, user_id, user_name, kind, via, actor_id, actor_name, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(accountId, groupId, e.user_id, e.user_name, e.kind, e.via, e.actor_id, e.actor_name, e.at);
  }

  /** Sự kiện tức thời từ Zalo. Nhóm chưa theo dõi thì bỏ qua. */
  async onChange(accountId: number, change: GroupChange, now = Date.now()): Promise<void> {
    const g = this.group(accountId, change.groupId);
    if (!g) return;
    if (change.groupName && change.groupName !== g.name) {
      this.db.prepare("UPDATE tracked_groups SET name = ? WHERE account_id = ? AND group_id = ?").run(change.groupName, accountId, change.groupId);
    }
    let actorName = "";
    if (change.actorId && !change.members.some((m) => m.id === change.actorId)) {
      actorName = (await this.deps.channel(accountId)?.memberNames([change.actorId]).catch(() => undefined))?.get(change.actorId) ?? "";
    }
    const joined: Member[] = [];
    for (const m of change.members) {
      if (change.kind === "join") {
        if (this.isPresent(accountId, change.groupId, m.id)) continue; // Zalo báo trùng
        this.markJoin(accountId, change.groupId, m, change.at);
        joined.push({ ...m, actorName });
      } else {
        this.markLeave(accountId, change.groupId, m, change.at);
      }
      this.addEvent(accountId, change.groupId, {
        user_id: m.id,
        user_name: m.name,
        kind: change.kind,
        via: change.via,
        actor_id: change.kind === "join" && change.via === "link" ? "" : change.actorId,
        actor_name: actorName,
        at: change.at,
      });
    }
    const delta = change.kind === "join" ? joined.length : -change.members.length;
    this.db.prepare("UPDATE tracked_groups SET member_count = MAX(0, member_count + ?) WHERE account_id = ? AND group_id = ?").run(delta, accountId, change.groupId);
    if (joined.length) this.queueWelcome(accountId, change.groupId, joined, now);
  }

  /**
   * Đối chiếu danh sách (lúc bật app, định kỳ, hoặc bấm tay). Ai vào/rời lúc app tắt được ghi
   * với via = "diff" và giờ là lúc phát hiện. Không chào những người này (không rõ họ vào lúc nào).
   */
  async reconcile(accountId: number, groupId?: string, now = Date.now()): Promise<{ joined: number; left: number }[]> {
    const ch = this.deps.channel(accountId);
    if (!ch?.isConnected()) return [];
    const groups = groupId ? [this.group(accountId, groupId)].filter(Boolean) as TrackedGroup[] : this.tracked(accountId);
    const out: { joined: number; left: number }[] = [];
    for (const g of groups) {
      try {
        const detail = await ch.groupDetail(g.group_id);
        this.admins.set(`${accountId}:${g.group_id}`, new Set([...detail.adminIds, detail.creatorId].filter(Boolean)));
        const d = diffMembers(this.presentIds(accountId, g.group_id), detail.memberIds, detail.totalMember);
        const names = d.joined.length || d.left.length ? await ch.memberNames([...d.joined, ...d.left]) : new Map<string, string>();
        const knownName = (id: string) =>
          (this.db.prepare("SELECT name FROM group_members WHERE account_id = ? AND group_id = ? AND user_id = ?").get(accountId, g.group_id, id) as { name?: string } | undefined)?.name ?? "";
        this.db.exec("BEGIN");
        try {
          for (const id of d.joined) {
            const m = { id, name: names.get(id) ?? "" };
            this.markJoin(accountId, g.group_id, m, now);
            this.addEvent(accountId, g.group_id, { user_id: id, user_name: m.name, kind: "join", via: "diff", actor_id: "", actor_name: "", at: now });
          }
          for (const id of d.left) {
            const m = { id, name: names.get(id) || knownName(id) };
            this.markLeave(accountId, g.group_id, m, now);
            this.addEvent(accountId, g.group_id, { user_id: id, user_name: m.name, kind: "leave", via: "diff", actor_id: "", actor_name: "", at: now });
          }
          this.db
            .prepare("UPDATE tracked_groups SET name = ?, member_count = ?, reconciled_at = ? WHERE account_id = ? AND group_id = ?")
            .run(detail.name || g.name, detail.totalMember || detail.memberIds.length, now, accountId, g.group_id);
          this.db.exec("COMMIT");
        } catch (err) {
          this.db.exec("ROLLBACK");
          throw err;
        }
        out.push({ joined: d.joined.length, left: d.left.length });
      } catch (err) {
        this.deps.log?.("Không đối chiếu được nhóm", { account: accountId, group: g.group_id, err: (err as Error).message });
      }
    }
    return out;
  }

  // ---------- Số liệu ----------

  events(accountId: number, groupId: string, opts: { from?: number; to?: number; limit?: number } = {}): (EventRow & { id: number })[] {
    return this.db
      .prepare("SELECT * FROM group_events WHERE account_id = ? AND group_id = ? AND at >= ? AND at <= ? ORDER BY at DESC, id DESC LIMIT ?")
      .all(accountId, groupId, opts.from ?? 0, opts.to ?? Number.MAX_SAFE_INTEGER, opts.limit ?? 5000) as unknown as (EventRow & { id: number })[];
  }

  members(accountId: number, groupId: string) {
    return this.db
      .prepare("SELECT user_id, name, present, first_seen_at, joined_at, left_at FROM group_members WHERE account_id = ? AND group_id = ? ORDER BY present DESC, COALESCE(joined_at, first_seen_at) DESC")
      .all(accountId, groupId) as { user_id: string; name: string; present: number; first_seen_at: number; joined_at: number | null; left_at: number | null }[];
  }

  stats(accountId: number, groupId: string, opts: { from: number; to: number; bucket: Bucket }, now = Date.now()) {
    const g = this.group(accountId, groupId);
    if (!g) throw new Error("Nhóm chưa được theo dõi");
    // Lấy cả sự kiện sau kỳ để tính giữ chân (ai rời trong 30 ngày sau khi vào).
    const events = this.events(accountId, groupId, { from: opts.from, to: Math.max(opts.to, now) });
    return { ...computeStats(events, { ...opts, now, currentMembers: g.member_count }), trackedAt: g.tracked_at, reconciledAt: g.reconciled_at };
  }

  // ---------- Luồng chào mừng ----------

  welcome(accountId: number, groupId: string): WelcomeConfig {
    const g = this.group(accountId, groupId);
    if (!g) throw new Error("Nhóm chưa được theo dõi");
    return sanitizeWelcome(JSON.parse(g.welcome || "{}"));
  }

  setWelcome(accountId: number, groupId: string, input: unknown): WelcomeConfig {
    const cfg = sanitizeWelcome(input);
    this.db.prepare("UPDATE tracked_groups SET welcome = ? WHERE account_id = ? AND group_id = ?").run(JSON.stringify(cfg), accountId, groupId);
    return cfg;
  }

  welcomeLog(accountId: number, groupId: string, limit = 100): WelcomeRow[] {
    return this.db
      .prepare("SELECT * FROM group_welcomes WHERE account_id = ? AND group_id = ? ORDER BY COALESCE(done_at, due_at) DESC, id DESC LIMIT ?")
      .all(accountId, groupId, limit) as unknown as WelcomeRow[];
  }

  /** Đã chào người này ở nhóm này trong N ngày qua chưa (để không chào lại người vào lại). */
  private welcomedRecently(accountId: number, groupId: string, userId: string, since: number): boolean {
    const rows = this.db
      .prepare("SELECT members FROM group_welcomes WHERE account_id = ? AND group_id = ? AND status IN ('sent', 'pending') AND created_at >= ?")
      .all(accountId, groupId, since) as { members: string }[];
    return rows.some((r) => (JSON.parse(r.members) as Member[]).some((m) => m.id === userId));
  }

  private queueWelcome(accountId: number, groupId: string, joined: Member[], now: number) {
    const cfg = this.welcome(accountId, groupId);
    if (!cfg.enabled) return;
    const own = this.deps.channel(accountId)?.ownId() ?? "";
    const admins = this.admins.get(`${accountId}:${groupId}`) ?? new Set<string>();
    const since = now - cfg.skipRejoinDays * 86_400_000;
    const fresh = joined.filter((m) => m.id !== own && !admins.has(m.id) && !this.welcomedRecently(accountId, groupId, m.id, since));
    if (fresh.length === 0) return;

    if (cfg.group.enabled) {
      // Gom người vào gần nhau thành một tin: còn đợt đang mở thì thêm vào đợt đó.
      const open = this.db
        .prepare("SELECT * FROM group_welcomes WHERE account_id = ? AND group_id = ? AND kind = 'group' AND status = 'pending' AND due_at > ? ORDER BY id DESC LIMIT 1")
        .get(accountId, groupId, now) as unknown as WelcomeRow | undefined;
      if (open && open.due_at - now <= cfg.group.batchSeconds * 1000 + 1000) {
        const members = [...(JSON.parse(open.members) as Member[]), ...fresh].slice(0, 20);
        this.db.prepare("UPDATE group_welcomes SET members = ? WHERE id = ?").run(JSON.stringify(members), open.id);
      } else {
        const due = afterQuiet(now + cfg.group.batchSeconds * 1000, cfg.quietStart, cfg.quietEnd);
        this.insertWelcome(accountId, groupId, "group", fresh, due, now);
      }
    }
    if (cfg.private.enabled) {
      const taken = (
        this.db
          .prepare(
            `SELECT COALESCE(done_at, due_at) AS t FROM group_welcomes
             WHERE account_id = ? AND kind = 'private' AND (status = 'pending' OR (status = 'sent' AND done_at >= ?))`,
          )
          .all(accountId, now - 86_400_000) as { t: number }[]
      ).map((r) => r.t);
      for (const m of fresh) {
        const due = planPrivateSlot(now, taken, cfg, this.rand);
        taken.push(due);
        this.insertWelcome(accountId, groupId, "private", [m], due, now);
      }
    }
  }

  private insertWelcome(accountId: number, groupId: string, kind: "group" | "private", members: Member[], due: number, now: number) {
    this.db
      .prepare("INSERT INTO group_welcomes (account_id, group_id, kind, members, status, due_at, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)")
      .run(accountId, groupId, kind, JSON.stringify(members), due, now);
  }

  private finish(id: number, status: WelcomeRow["status"], now: number, text = "", error = "") {
    this.db.prepare("UPDATE group_welcomes SET status = ?, done_at = ?, text = ?, error = ? WHERE id = ?").run(status, now, text, error.slice(0, 500), id);
  }

  /** Xem thử tin chào với tên mẫu. */
  preview(accountId: number, groupId: string, kind: "group" | "private", cfg?: unknown) {
    const g = this.group(accountId, groupId);
    if (!g) throw new Error("Nhóm chưa được theo dõi");
    const c = cfg ? sanitizeWelcome(cfg) : this.welcome(accountId, groupId);
    const sample = kind === "group" ? [{ id: "1", name: "Lan Anh" }, { id: "2", name: "Minh Tuấn" }] : [{ id: "1", name: "Lan Anh" }];
    const templates = kind === "group" ? c.group.templates : c.private.templates;
    return templates.map((t) => renderWelcome(t, { members: sample, groupName: g.name, memberCount: g.member_count, adderName: "Thu Thảo" }, kind === "group").text);
  }

  /** Gửi các lời chào đến hạn. Chạy mỗi 15 giây. */
  async tick(now = Date.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const due = this.db.prepare("SELECT * FROM group_welcomes WHERE status = 'pending' AND due_at <= ? ORDER BY due_at LIMIT 20").all(now) as unknown as WelcomeRow[];
      for (const w of due) await this.sendOne(w, now);
    } finally {
      this.ticking = false;
    }
  }

  private async sendOne(w: WelcomeRow, now: number) {
    const g = this.group(w.account_id, w.group_id);
    if (!g) return;
    const cfg = sanitizeWelcome(JSON.parse(g.welcome || "{}"));
    const part = w.kind === "group" ? cfg.group : cfg.private;
    if (!cfg.enabled || !part.enabled) return this.finish(w.id, "skipped", now, "", "Luồng chào đã tắt");
    const ch = this.deps.channel(w.account_id);
    const late = now - w.due_at > LATE_MS;
    if (!ch?.isConnected() || this.deps.isPaused(w.account_id)) {
      if (late) this.finish(w.id, "skipped", now, "", ch?.isConnected() ? "Trợ lý tạm dừng quá lâu" : "Zalo không kết nối quá lâu");
      return; // chờ lượt sau
    }
    const members = (JSON.parse(w.members) as Member[]).filter((m) => this.isPresent(w.account_id, w.group_id, m.id));
    if (members.length === 0) return this.finish(w.id, "skipped", now, "", "Người mới đã rời nhóm");
    const { text, mentions } = renderWelcome(
      pickTemplate(part.templates, this.rand),
      { members, groupName: g.name, memberCount: g.member_count, adderName: members[0]?.actorName ?? "" },
      w.kind === "group",
    );
    const images = part.imageIds.map((id) => this.deps.mediaPath(id)).filter((p): p is string => Boolean(p));
    try {
      if (w.kind === "group") {
        if (images.length) await ch.sendImages(w.group_id, "group", images);
        const id = await ch.sendMention(w.group_id, text, mentions);
        ch.recordOutbound(w.group_id, "group", text, id, g.name);
      } else {
        const m = members[0]!;
        if (images.length) await ch.sendImages(m.id, "user", images);
        const ids = await ch.sendText(m.id, text);
        ch.recordOutbound(m.id, "user", text, ids[0] ?? null, m.name);
      }
      this.finish(w.id, "sent", now, text);
    } catch (err) {
      // Người chặn tin người lạ, Zalo từ chối…: ghi lại, không thử lại liên tục.
      this.finish(w.id, "failed", now, text, (err as Error).message);
      this.deps.log?.("Không gửi được lời chào", { id: w.id, err: (err as Error).message });
    }
  }

  // ---------- Chạy nền ----------

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((err) => this.deps.log?.("Lỗi luồng chào", { err: (err as Error).message })), TICK_MS);
    this.timer.unref();
    this.reconcileTimer = setInterval(() => void this.reconcileAll(), RECONCILE_EVERY_MS);
    this.reconcileTimer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.timer = this.reconcileTimer = null;
  }

  async reconcileAll() {
    for (const id of this.deps.accountIds()) await this.reconcile(id).catch(() => undefined);
  }

  private requireChannel(accountId: number): GroupChannel {
    const ch = this.deps.channel(accountId);
    if (!ch?.isConnected()) throw new Error("Zalo chưa kết nối");
    return ch;
  }
}
