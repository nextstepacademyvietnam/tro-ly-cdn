import { inQuietVN, vnDay } from "../care/prompt.js";
import type { DB } from "../server/db.js";

/** Mỗi lượt tìm tối đa ngần này số cho một nick (một lần gọi Zalo). */
export const BATCH = 5;
/** Trần an toàn mỗi nick: số tìm trong 1 giờ / trong một ngày (giờ VN). */
// Thử thật 19/11/2026: một lần tìm 20 số là Zalo báo "tìm số điện thoại quá nhiều lần trong 1 giờ" ngay, nên đi rất chậm.
export const PER_HOUR = 10;
export const PER_DAY = 40;
/** Số đã tìm thì ngần này ngày sau mới tìm lại (khách có thể đổi cài đặt cho tìm theo số). */
export const RECHECK_MS = 30 * 86_400_000;
/** Zalo báo giới hạn thì nghỉ nick đó ngần này, nhân đôi mỗi lần bị nhắc liên tiếp (tối đa 7 ngày). */
export const PAUSE_MS = 24 * 3_600_000;
const MAX_PAUSE_MS = 7 * PAUSE_MS;
const TICK_MS = 30 * 60_000;

/** Những gì bộ tìm cần từ một nick Zalo. */
export interface PhoneLookupAccount {
  isConnected(): boolean;
  /** Tìm nhiều số (0xxxxxxxxx) → uid + tên Zalo; số không có Zalo / ẩn tìm kiếm thì vắng trong kết quả. */
  usersByPhones(phones: string[]): Promise<Map<string, { uid: string; name: string }>>;
}

export interface ZaloMatchDeps {
  db: DB;
  box: { decrypt(sealed: string): string };
  accountIds(): number[];
  account(id: number): PhoneLookupAccount | undefined;
  /** Báo chủ (chuông) một lần khi một nick bị tạm dừng tìm. */
  notify?(accountId: number, text: string): void;
  now?: () => number;
  log?: (msg: string, extra?: object) => void;
}

interface Usage {
  day: string;
  dayCount: number;
  hour: number[];
  pausedUntil: number;
  lastError: string;
  /** Số lần Zalo nhắc liên tiếp (tìm được lại thì về 0). */
  strikes?: number;
}

/**
 * Nối CRM → Zalo theo số điện thoại: nhờ Zalo tìm số của lead (ưu tiên khách đang theo) ra tài khoản Zalo, ghi vào
 * `crm_zalo`. Khách đó nhắn Zalo thì Hộp thư và trợ lý biết ngay họ là ai trong CRM, không cần so tên.
 * Đi chậm có trần (Zalo giới hạn tìm theo số), nghỉ giờ yên lặng, Zalo báo lỗi thì dừng nick đó 24 giờ.
 */
export class ZaloMatcher {
  private readonly now: () => number;
  private readonly usage = new Map<number, Usage>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(private readonly d: ZaloMatchDeps) {
    this.now = d.now ?? Date.now;
  }

  private use(accountId: number): Usage {
    const day = vnDay(this.now());
    let u = this.usage.get(accountId);
    if (!u) {
      const saved = this.d.db.prepare("SELECT value FROM settings WHERE key = ?").get(`crm.zaloUsage.${accountId}`) as { value: string } | undefined;
      u = saved ? (JSON.parse(saved.value) as Usage) : { day, dayCount: 0, hour: [], pausedUntil: 0, lastError: "" };
      this.usage.set(accountId, u);
    }
    if (u.day !== day) Object.assign(u, { day, dayCount: 0 });
    u.hour = u.hour.filter((t) => this.now() - t < 3_600_000);
    return u;
  }

  private save(accountId: number, u: Usage) {
    this.d.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(`crm.zaloUsage.${accountId}`, JSON.stringify(u));
  }

  /** Số còn được tìm ngay lúc này cho nick (0 nếu đang nghỉ, giờ yên lặng, hết trần). */
  room(accountId: number): number {
    const u = this.use(accountId);
    if (inQuietVN(this.now()) || u.pausedUntil > this.now()) return 0;
    return Math.max(0, Math.min(BATCH, PER_HOUR - u.hour.length, PER_DAY - u.dayCount));
  }

  /** Các số cần tìm cho nick: chưa tìm, hoặc tìm đã quá 30 ngày; khách đang theo trước, lead mới trước. */
  pending(accountId: number, limit: number): { hash: string; phone: string }[] {
    const rows = this.d.db
      .prepare(
        `SELECT i.phone_hash AS hash, MIN(i.priority) AS prio, MAX(i.created_on) AS created, MAX(i.phone_enc) AS enc
         FROM crm_index i LEFT JOIN crm_zalo z ON z.account_id = ? AND z.phone_hash = i.phone_hash
         WHERE i.phone_enc <> '' AND (z.phone_hash IS NULL OR z.checked_at < ?)
         GROUP BY i.phone_hash ORDER BY prio, created DESC LIMIT ?`,
      )
      .all(accountId, this.now() - RECHECK_MS, limit) as { hash: string; enc: string }[];
    const out: { hash: string; phone: string }[] = [];
    for (const r of rows) {
      try {
        out.push({ hash: r.hash, phone: this.d.box.decrypt(r.enc) });
      } catch {
        /* khoá mã hoá đổi: bỏ qua, lần dựng chỉ mục sau sẽ mã hoá lại */
      }
    }
    return out;
  }

  /** Một lượt tìm cho một nick. Trả số đã tìm. */
  async runAccount(accountId: number): Promise<number> {
    const acc = this.d.account(accountId);
    if (!acc?.isConnected()) return 0;
    const n = this.room(accountId);
    if (!n) return 0;
    const batch = this.pending(accountId, n);
    if (!batch.length) return 0;
    const u = this.use(accountId);
    let found: Map<string, { uid: string; name: string }>;
    try {
      found = await acc.usersByPhones(batch.map((b) => b.phone));
    } catch (err) {
      u.strikes = (u.strikes ?? 0) + 1;
      u.pausedUntil = this.now() + Math.min(MAX_PAUSE_MS, PAUSE_MS * 2 ** (u.strikes - 1));
      u.lastError = (err as Error).message.slice(0, 200);
      this.save(accountId, u);
      this.d.log?.("Zalo từ chối tìm theo số, tạm nghỉ", { account: accountId, err: u.lastError });
      this.d.notify?.(accountId, `Zalo chưa cho tìm thêm khách CRM theo số điện thoại (${u.lastError}). App tạm nghỉ phần này ${Math.round((u.pausedUntil - this.now()) / 3_600_000)} giờ rồi thử lại, chậm hơn; trợ lý vẫn chạy bình thường.`);
      return 0;
    }
    const now = this.now();
    const put = this.d.db.prepare("INSERT OR REPLACE INTO crm_zalo (account_id, phone_hash, uid, zalo_name, checked_at) VALUES (?, ?, ?, ?, ?)");
    this.d.db.exec("BEGIN");
    try {
      for (const b of batch) {
        const hit = found.get(b.phone);
        put.run(accountId, b.hash, hit?.uid ?? "", hit?.name ?? "", now);
      }
      this.d.db.exec("COMMIT");
    } catch (err) {
      this.d.db.exec("ROLLBACK");
      throw err;
    }
    u.dayCount += batch.length;
    for (let i = 0; i < batch.length; i++) u.hour.push(now);
    u.lastError = "";
    u.strikes = 0;
    this.save(accountId, u);
    return batch.length;
  }

  /** Tiến độ cho thẻ Pancake: khách đang theo đã tìm / tổng, số có Zalo, đã tìm hôm nay. */
  progress(accountId: number) {
    const q = (sql: string, ...a: (string | number)[]) => Number((this.d.db.prepare(sql).get(...a) as { n: number }).n);
    const u = this.use(accountId);
    return {
      priorityTotal: q("SELECT COUNT(DISTINCT phone_hash) AS n FROM crm_index WHERE priority = 0 AND phone_enc <> ''"),
      priorityChecked: q(
        "SELECT COUNT(DISTINCT i.phone_hash) AS n FROM crm_index i JOIN crm_zalo z ON z.phone_hash = i.phone_hash AND z.account_id = ? WHERE i.priority = 0",
        accountId,
      ),
      total: q("SELECT COUNT(DISTINCT phone_hash) AS n FROM crm_index WHERE phone_enc <> ''"),
      checked: q("SELECT COUNT(*) AS n FROM crm_zalo WHERE account_id = ?", accountId),
      withZalo: q("SELECT COUNT(*) AS n FROM crm_zalo WHERE account_id = ? AND uid <> ''", accountId),
      today: u.dayCount,
      perDay: PER_DAY,
      pausedUntil: u.pausedUntil > this.now() ? u.pausedUntil : 0,
      lastError: u.lastError,
    };
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const id of this.d.accountIds()) {
        try {
          await this.runAccount(id);
        } catch (err) {
          this.d.log?.("Lỗi tìm Zalo theo số", { account: id, err: (err as Error).message });
        }
      }
    } finally {
      this.busy = false;
    }
  }

  start() {
    if (this.timer) return;
    setTimeout(() => void this.tick(), 3 * 60_000).unref();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
