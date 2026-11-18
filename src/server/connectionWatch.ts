import type { AccountManager } from "../channels/zalo/accounts.js";
import type { AssistantStore } from "../core/assistantStore.js";

/** Zalo mất kết nối quá ngần này thì báo chủ (app vẫn tự nối lại trong lúc đó). */
export const DOWN_ALERT_MS = 10 * 60_000;

const hhmm = (t: number) =>
  new Date(t).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Ho_Chi_Minh" });

/**
 * Canh kết nối Zalo của từng tài khoản (đã từng kết nối): rớt quá 10 phút thì thông báo một lần cho mỗi lần rớt,
 * nối lại được thì báo đã nối lại. Tài khoản chưa bao giờ kết nối thì bỏ qua (đã có thẻ ở trang Tài khoản Zalo).
 */
export class ConnectionWatch {
  private readonly down = new Map<number, { since: number; alerted: boolean }>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly accounts: Pick<AccountManager, "list" | "get">,
    private readonly store: Pick<AssistantStore, "notify">,
    private readonly now: () => number = Date.now,
  ) {}

  check() {
    const now = this.now();
    for (const a of this.accounts.list()) {
      if (!a.own_id) continue;
      let st;
      try {
        st = this.accounts.get(a.id).channel.getStatus();
      } catch {
        continue;
      }
      const d = this.down.get(a.id);
      if (st.state === "connected") {
        if (d?.alerted) {
          const mins = Math.max(1, Math.round((now - d.since) / 60_000));
          this.store.notify(a.id, "error", `Zalo "${a.name}" đã kết nối lại sau ${mins} phút mất kết nối. Tin khách nhắn trong lúc đó vẫn ở Hộp thư.`, "", now);
        }
        this.down.delete(a.id);
        continue;
      }
      // Chủ đăng xuất hoặc đang quét mã QR: chủ đang tự làm, không báo.
      if (st.state === "logged_out" || st.state === "waiting_qr" || st.state === "scanned") {
        this.down.delete(a.id);
        continue;
      }
      const since = d?.since ?? Math.min(now, st.since || now);
      if (!d) this.down.set(a.id, { since, alerted: false });
      const cur = this.down.get(a.id)!;
      if (!cur.alerted && now - cur.since >= DOWN_ALERT_MS) {
        cur.alerted = true;
        const why = st.error ? ` (${st.error})` : "";
        this.store.notify(
          a.id,
          "error",
          `Zalo "${a.name}" mất kết nối từ ${hhmm(cur.since)}${why}: trợ lý không nhận được tin khách. App vẫn đang tự nối lại; nếu Zalo báo hết phiên, vào Tài khoản Zalo quét lại mã QR.`,
          "",
          now,
        );
      }
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), 60_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
