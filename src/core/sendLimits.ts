/**
 * Giới hạn số tin trợ lý TỰ GỬI (không qua duyệt) — chặn hai bot nhắn qua lại mãi, và để nick không bị Zalo hạn chế.
 * Chạm giới hạn thì câu trả lời giữ ở dạng nháp chờ chủ duyệt, báo chủ một lần. Mỗi nick tự chỉnh được, có mức mặc định.
 */
export interface SendLimits {
  /** Chat riêng: tối đa tin tự gửi cho một khách trong 1 giờ / 24 giờ. */
  privateHour: number;
  privateDay: number;
  /** Nhóm: tối đa tin trả lời một người trong 1 giờ. */
  groupPerSenderHour: number;
  /** Nhóm: tối đa tin tự gửi vào cả nhóm trong 1 giờ / 24 giờ. */
  groupHour: number;
  groupDay: number;
  /** Nhóm bật "tự trả lời câu hỏi": tối đa tin khi không ai gọi trợ lý, trong 1 giờ. */
  groupAutoHour: number;
}

export const DEFAULT_SEND_LIMITS: SendLimits = {
  privateHour: 6,
  privateDay: 15,
  groupPerSenderHour: 6,
  groupHour: 20,
  groupDay: 60,
  groupAutoHour: 4,
};

/** Khoảng cho phép của từng ô, để chủ không lỡ tay đặt 0 (trợ lý tắt hẳn) hay quá cao (dễ bị Zalo khoá). */
export const SEND_LIMIT_RANGE: Record<keyof SendLimits, [number, number]> = {
  privateHour: [1, 30],
  privateDay: [1, 200],
  groupPerSenderHour: [1, 30],
  groupHour: [1, 100],
  groupDay: [1, 500],
  groupAutoHour: [1, 30],
};

/** Ghép giá trị chủ lưu với mặc định; ô thiếu / sai thì lấy mặc định, ô ngoài khoảng thì kẹp vào khoảng. */
export function normalizeLimits(input: unknown): SendLimits {
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_SEND_LIMITS };
  for (const key of Object.keys(DEFAULT_SEND_LIMITS) as (keyof SendLimits)[]) {
    const n = Math.round(Number(src[key]));
    if (!Number.isFinite(n) || src[key] === null || src[key] === "" || src[key] === undefined) continue;
    const [lo, hi] = SEND_LIMIT_RANGE[key];
    out[key] = Math.min(hi, Math.max(lo, n));
  }
  // Mức 24 giờ không nhỏ hơn mức 1 giờ.
  out.privateDay = Math.max(out.privateDay, out.privateHour);
  out.groupDay = Math.max(out.groupDay, out.groupHour);
  return out;
}

export const limitsKey = (accountId: number) => `limits.${accountId}`;
