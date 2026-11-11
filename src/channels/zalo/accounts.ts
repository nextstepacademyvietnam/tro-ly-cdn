import type { DB } from "../../server/db.js";
import type { Settings } from "../../server/settings.js";
import type { ScheduleTarget } from "../../scheduler/store.js";
import type { Replier, ReplierAccount } from "../../core/replier.js";
import { ZaloService } from "./service.js";
import type { GroupChange } from "./groupEvents.js";
import type { GroupChannel } from "../../groups/tracker.js";

export interface AccountRow {
  id: number;
  name: string;
  own_id: string;
  off_tag: string;
  created_at: number;
}

export class AccountError extends Error {}

/**
 * Quản lý nhiều tài khoản Zalo. Mỗi tài khoản có kết nối, hộp thư, tính cách, lịch riêng;
 * mô hình AI dùng chung. Một nick Zalo không được đăng nhập vào hai tài khoản.
 */
export class AccountManager {
  private readonly services = new Map<number, ZaloService>();
  private replier: Replier | null = null;
  /** Bộ theo dõi nhóm nghe sự kiện vào/rời nhóm và lúc tài khoản vừa kết nối (để đối chiếu). */
  onGroupChange?: (accountId: number, change: GroupChange) => void;
  onConnected?: (accountId: number) => void;

  constructor(
    private readonly db: DB,
    private readonly settings: Settings,
    private readonly dataDir: string,
    private readonly log: (msg: string, extra?: object) => void = () => {},
  ) {
    for (const a of this.list()) this.attach(a.id);
  }

  list(): AccountRow[] {
    return this.db.prepare("SELECT * FROM accounts ORDER BY id").all() as unknown as AccountRow[];
  }

  row(id: number): AccountRow | undefined {
    return this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as unknown as AccountRow | undefined;
  }

  firstId(): number {
    return this.list()[0]?.id ?? this.create("Tài khoản 1").id;
  }

  get(id: number): ZaloService {
    const s = this.services.get(id);
    if (!s) throw new AccountError("Không có tài khoản này");
    return s;
  }

  /** Nối bộ trả lời AI: mọi tin mới và tín hiệu "đang gõ" của mọi tài khoản đi qua nó. */
  setReplier(replier: Replier) {
    this.replier = replier;
  }

  /** Cái nhìn rút gọn của một tài khoản cho bộ trả lời. */
  replierAccount(id: number): ReplierAccount | undefined {
    const svc = this.services.get(id);
    if (!svc) return undefined;
    return {
      accountId: id,
      inbox: svc.inbox,
      ownId: () => svc.channel.getStatus().ownId ?? this.row(id)?.own_id ?? "",
      ownerName: () => svc.channel.getStatus().ownName || this.row(id)?.name || "chủ tài khoản",
      isConnected: () => svc.isConnected(),
      labels: () => svc.channel.labels(),
      groupName: (threadId) => svc.channel.groupName(threadId),
      sendText: (threadId, type, text) => svc.channel.sendText(threadId, type, text),
      setLabel: (threadId, type, target, exclusive) => svc.channel.setLabel(threadId, type, target, exclusive),
    };
  }

  trackedGroupCount(id: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM tracked_groups WHERE account_id = ?").get(id) as { n: number }).n;
  }

  /** Cái nhìn rút gọn của một tài khoản cho bộ theo dõi nhóm. */
  groupChannel(id: number): GroupChannel | undefined {
    const svc = this.services.get(id);
    if (!svc) return undefined;
    const ch = svc.channel;
    return {
      isConnected: () => svc.isConnected(),
      ownId: () => ch.getStatus().ownId ?? this.row(id)?.own_id ?? "",
      groups: () => ch.groups(),
      groupDetail: (groupId) => ch.groupDetail(groupId),
      memberNames: (ids) => ch.memberNames(ids),
      sendMention: (groupId, text, mentions) => ch.sendMention(groupId, text, mentions),
      sendText: (userId, text) => ch.sendText(userId, "user", text),
      sendImages: (threadId, type, paths) => ch.sendImages(threadId, type, paths),
      recordOutbound: (threadId, type, text, msgId, name) => svc.inbox.recordOutbound(threadId, type, text, "ai", msgId, Date.now(), "welcome", name),
    };
  }

  private attach(id: number): ZaloService {
    const svc = new ZaloService(this.db, this.settings, this.dataDir, id);
    svc.onRecorded = (event, sentByApp) => this.replier?.onInbound(id, event, sentByApp);
    svc.onOwnerSent = (threadId) => this.replier?.ownerReplied(id, threadId);
    svc.channel.on("typing", (t) => this.replier?.onTyping(id, t.threadId, t.senderId));
    svc.channel.on("group", (change) => this.onGroupChange?.(id, change));
    svc.channel.on("status", (s) => {
      this.log("Zalo", { account: id, state: s.state, error: s.error });
      if (s.state !== "connected" || !s.ownId) return;
      this.onConnected?.(id);
      const dup = this.list().find((a) => a.id !== id && a.own_id === s.ownId);
      if (dup) {
        // Cùng một nick ở hai nơi sẽ đá nhau liên tục: giữ tài khoản cũ, đăng xuất tài khoản mới.
        void svc.channel.logout().then(() =>
          svc.channel.emit("status", {
            state: "error",
            since: Date.now(),
            error: `Nick Zalo này đang dùng ở "${dup.name}". Mỗi nick chỉ được đăng nhập ở một tài khoản.`,
          }),
        );
        return;
      }
      this.db.prepare("UPDATE accounts SET own_id = ? WHERE id = ?").run(s.ownId, id);
      const row = this.row(id);
      if (row && /^Tài khoản \d+$/.test(row.name) && s.ownName) {
        this.db.prepare("UPDATE accounts SET name = ? WHERE id = ?").run(s.ownName, id);
      }
    });
    this.services.set(id, svc);
    return svc;
  }

  create(name: string): AccountRow {
    const clean = name.trim().slice(0, 80) || `Tài khoản ${this.list().length + 1}`;
    const r = this.db.prepare("INSERT INTO accounts (name, created_at) VALUES (?, ?)").run(clean, Date.now());
    const id = Number(r.lastInsertRowid);
    this.attach(id);
    return this.row(id)!;
  }

  rename(id: number, name: string): void {
    const clean = name.trim().slice(0, 80);
    if (!clean) throw new AccountError("Tên không được trống");
    this.db.prepare("UPDATE accounts SET name = ? WHERE id = ?").run(clean, id);
  }

  setOffTag(id: number, tag: string): void {
    this.db.prepare("UPDATE accounts SET off_tag = ? WHERE id = ?").run(tag.trim().slice(0, 60) || "Không bot", id);
  }

  /** Xoá hẳn tài khoản: đăng xuất Zalo, xoá hộp thư, tính cách, lịch của nó. */
  async remove(id: number): Promise<void> {
    if (this.list().length <= 1) throw new AccountError("Phải giữ ít nhất một tài khoản");
    const svc = this.services.get(id);
    if (svc) await svc.channel.logout();
    this.services.delete(id);
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM schedules WHERE account_id = ?").run(id);
      this.db.prepare("DELETE FROM persona_files WHERE profile_id IN (SELECT id FROM profiles WHERE account_id = ?)").run(id);
      this.db.prepare("DELETE FROM accounts WHERE id = ?").run(id); // hộp thư, tính cách xoá theo khoá ngoại
      this.db.prepare("DELETE FROM settings WHERE key = ?").run(`zalo.credentials.${id}`);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async startAll(): Promise<void> {
    await Promise.all([...this.services.values()].map((s) => s.start().catch(() => undefined)));
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.services.values()].map((s) => s.stop()));
  }

  // ---- Dùng cho bộ chạy lịch ----
  isConnected(accountId: number): boolean {
    return this.services.get(accountId)?.isConnected() ?? false;
  }

  send(accountId: number, target: ScheduleTarget, text: string, imagePaths: string[]): Promise<void> {
    return this.get(accountId).send(target, text, imagePaths);
  }
}
