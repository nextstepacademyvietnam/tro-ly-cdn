/**
 * Nhịp gửi tin giống người thật, để giảm rủi ro Zalo hạn chế tài khoản:
 * cách nhau tối thiểu, trần theo giờ/ngày, giờ yên lặng cho tin chủ động.
 */
export interface PacingOptions {
  minGapMs: number;
  maxPerHour: number;
  maxPerDay: number;
  /** Giờ yên lặng (giờ Việt Nam) cho tin chủ động — trả lời khách vẫn đi. */
  quietStartHour: number;
  quietEndHour: number;
}

export const DEFAULT_PACING: PacingOptions = {
  minGapMs: 2_500,
  maxPerHour: 80,
  maxPerDay: 400,
  quietStartHour: 22,
  quietEndHour: 7,
};

export type PaceDecision = { ok: true; waitMs: number } | { ok: false; reason: string };

export class SendPacer {
  private sent: number[] = [];
  private lastAt = 0;

  constructor(private readonly opts: PacingOptions = DEFAULT_PACING) {}

  /** Giữ chỗ một lượt gửi. `waitMs` là thời gian phải chờ trước khi gửi. */
  reserve(now = Date.now(), proactive = false): PaceDecision {
    this.sent = this.sent.filter((t) => now - t < 86_400_000);
    if (proactive && inQuietHours(now, this.opts)) {
      return { ok: false, reason: `Đang trong giờ yên lặng (${this.opts.quietStartHour}h–${this.opts.quietEndHour}h), tin chủ động sẽ không gửi` };
    }
    const lastHour = this.sent.filter((t) => now - t < 3_600_000).length;
    if (lastHour >= this.opts.maxPerHour) return { ok: false, reason: `Đã gửi ${lastHour} tin trong 1 giờ qua — chạm trần an toàn` };
    if (this.sent.length >= this.opts.maxPerDay) return { ok: false, reason: `Đã gửi ${this.sent.length} tin trong 24 giờ qua — chạm trần an toàn` };
    const at = Math.max(now, this.lastAt + this.opts.minGapMs);
    this.lastAt = at;
    this.sent.push(at);
    return { ok: true, waitMs: at - now };
  }
}

export function inQuietHours(now: number, opts: Pick<PacingOptions, "quietStartHour" | "quietEndHour">): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", hourCycle: "h23" }).format(now),
  );
  const { quietStartHour: s, quietEndHour: e } = opts;
  return s === e ? false : s < e ? hour >= s && hour < e : hour >= s || hour < e;
}

/** Thời gian "đang gõ" trước khi gửi, theo độ dài tin. */
export function typingDelayMs(text: string): number {
  return Math.min(8_000, Math.max(1_200, 900 + text.length * 35));
}
