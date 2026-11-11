/**
 * Phần tính toán thuần của tính năng nhóm (không đụng DB hay Zalo): cấu hình lời chào,
 * dựng tin có tag tên, xếp giờ gửi lời chào riêng, đối chiếu danh sách, thống kê.
 */

// ---------- Cấu hình luồng chào mừng ----------

export interface WelcomeConfig {
  enabled: boolean;
  group: { enabled: boolean; templates: string[]; imageIds: number[]; batchSeconds: number };
  private: { enabled: boolean; templates: string[]; imageIds: number[]; minDelayMin: number; maxDelayMin: number; perHour: number; perDay: number };
  /** Giờ yên lặng theo giờ Việt Nam, "HH:MM". Lời chào rơi vào khoảng này dồn sang lúc hết giờ yên lặng. */
  quietStart: string;
  quietEnd: string;
  /** Người vào lại trong số ngày này thì không chào nữa. */
  skipRejoinDays: number;
}

export const DEFAULT_WELCOME: WelcomeConfig = {
  enabled: false,
  group: {
    enabled: true,
    templates: ["Chào mừng {ten} đến với {ten_nhom}! Mọi người nhớ đọc nội quy ở tin ghim nhé."],
    imageIds: [],
    batchSeconds: 120,
  },
  private: {
    enabled: false,
    templates: ["Chào {ten}, cảm ơn bạn đã tham gia {ten_nhom}. Có gì cần hỗ trợ cứ nhắn mình nhé!"],
    imageIds: [],
    minDelayMin: 2,
    maxDelayMin: 6,
    perHour: 10,
    perDay: 40,
  },
  quietStart: "21:30",
  quietEnd: "07:30",
  skipRejoinDays: 30,
};

const clampInt = (v: unknown, min: number, max: number, dflt: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};
const cleanTemplates = (v: unknown, dflt: string[]) => {
  const list = Array.isArray(v) ? v.map((t) => String(t ?? "").trim().slice(0, 1000)).filter(Boolean).slice(0, 5) : [];
  return list.length ? list : dflt;
};
const cleanIds = (v: unknown) => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 10) : []);
const cleanTime = (v: unknown, dflt: string) => (typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : dflt);

/** Ghép cấu hình người dùng gửi lên với mặc định, chặn giá trị vô lý. */
export function sanitizeWelcome(input: unknown): WelcomeConfig {
  const i = (input ?? {}) as Partial<WelcomeConfig> & { group?: Partial<WelcomeConfig["group"]>; private?: Partial<WelcomeConfig["private"]> };
  const d = DEFAULT_WELCOME;
  const g: Partial<WelcomeConfig["group"]> = i.group ?? {};
  const p: Partial<WelcomeConfig["private"]> = i.private ?? {};
  const minDelay = clampInt(p.minDelayMin, 0, 120, d.private.minDelayMin);
  return {
    enabled: Boolean(i.enabled),
    group: {
      enabled: g.enabled === undefined ? d.group.enabled : Boolean(g.enabled),
      templates: cleanTemplates(g.templates, d.group.templates),
      imageIds: cleanIds(g.imageIds),
      batchSeconds: clampInt(g.batchSeconds, 0, 1800, d.group.batchSeconds),
    },
    private: {
      enabled: Boolean(p.enabled),
      templates: cleanTemplates(p.templates, d.private.templates),
      imageIds: cleanIds(p.imageIds),
      minDelayMin: minDelay,
      maxDelayMin: Math.max(minDelay, clampInt(p.maxDelayMin, 0, 240, d.private.maxDelayMin)),
      perHour: clampInt(p.perHour, 1, 60, d.private.perHour),
      perDay: clampInt(p.perDay, 1, 300, d.private.perDay),
    },
    quietStart: cleanTime(i.quietStart, d.quietStart),
    quietEnd: cleanTime(i.quietEnd, d.quietEnd),
    skipRejoinDays: clampInt(i.skipRejoinDays, 0, 365, d.skipRejoinDays),
  };
}

// ---------- Dựng tin ----------

export interface WelcomeContext {
  members: { id: string; name: string }[];
  groupName: string;
  memberCount: number;
  adderName: string;
}

/**
 * Điền mẫu. Trong nhóm, {ten} thành "@A, @B và @C" kèm vị trí tag cho từng người;
 * tin riêng chỉ có một người và không tag.
 */
export function renderWelcome(template: string, ctx: WelcomeContext, withMentions: boolean): { text: string; mentions: { pos: number; uid: string; len: number }[] } {
  const names = ctx.members.map((m) => (withMentions ? `@${m.name || "bạn mới"}` : m.name || "bạn"));
  const vars: Record<string, string> = {
    ten_nhom: ctx.groupName || "nhóm",
    so_thanh_vien: ctx.memberCount ? String(ctx.memberCount) : "",
    nguoi_them: ctx.adderName,
  };
  const mentions: { pos: number; uid: string; len: number }[] = [];
  let text = "";
  // Đi từng đoạn để tính đúng vị trí tag sau khi các biến khác đã được thay.
  for (const part of template.split(/(\{[a-z_]+\})/g)) {
    const key = part.match(/^\{([a-z_]+)\}$/)?.[1];
    if (key === "ten") {
      names.forEach((n, i) => {
        if (i > 0) text += i === names.length - 1 ? " và " : ", ";
        if (withMentions) mentions.push({ pos: text.length, uid: ctx.members[i]!.id, len: n.length });
        text += n;
      });
    } else if (key && key in vars) text += vars[key];
    else text += part;
  }
  return { text: text.replace(/[ \t]{2,}/g, " ").trim(), mentions };
}

export const pickTemplate = (templates: string[], rand = Math.random) => templates[Math.floor(rand() * templates.length)] ?? templates[0] ?? "";

// ---------- Giờ yên lặng và xếp lịch lời chào riêng ----------

const VN_OFFSET = 7 * 3_600_000;
const minutesOfDayVN = (ts: number) => Math.floor(((ts + VN_OFFSET) % 86_400_000) / 60_000);
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function inQuiet(ts: number, start: string, end: string): boolean {
  const m = minutesOfDayVN(ts);
  const s = toMin(start);
  const e = toMin(end);
  return s === e ? false : s < e ? m >= s && m < e : m >= s || m < e;
}

/** Thời điểm sớm nhất ≥ ts mà hết giờ yên lặng. */
export function afterQuiet(ts: number, start: string, end: string): number {
  if (!inQuiet(ts, start, end)) return ts;
  const m = minutesOfDayVN(ts);
  const e = toMin(end);
  const wait = (e - m + 1440) % 1440;
  return ts - (ts % 60_000) + wait * 60_000;
}

/**
 * Xếp giờ gửi một lời chào riêng: cách lời chào trước một khoảng ngẫu nhiên, không quá
 * perHour tin trong 1 giờ và perDay tin trong 24 giờ, không rơi vào giờ yên lặng.
 * `taken` là giờ của các lời chào riêng đã gửi hoặc đã xếp (mọi nhóm của tài khoản).
 */
export function planPrivateSlot(now: number, taken: number[], cfg: WelcomeConfig, rand = Math.random): number {
  const p = cfg.private;
  const gap = () => (p.minDelayMin + rand() * (p.maxDelayMin - p.minDelayMin)) * 60_000;
  const sorted = [...taken].sort((a, b) => a - b);
  const last = sorted.at(-1) ?? 0;
  let t = Math.max(now + gap(), last ? last + gap() : 0);
  for (let i = 0; i < 1000; i++) {
    t = afterQuiet(t, cfg.quietStart, cfg.quietEnd);
    const hour = sorted.filter((x) => x > t - 3_600_000 && x <= t);
    if (hour.length >= p.perHour) {
      t = hour[hour.length - p.perHour]! + 3_600_000 + 1000;
      continue;
    }
    const day = sorted.filter((x) => x > t - 86_400_000 && x <= t);
    if (day.length >= p.perDay) {
      t = day[day.length - p.perDay]! + 86_400_000 + 1000;
      continue;
    }
    return Math.round(t);
  }
  return Math.round(t);
}

// ---------- Đối chiếu danh sách thành viên ----------

/**
 * So danh sách hiện tại với danh sách đã lưu. Zalo đôi khi trả thiếu thành viên ở nhóm lớn:
 * khi danh sách nhận được ít hơn 90% tổng số Zalo báo, không kết luận ai rời (tránh báo rời giả).
 */
export function diffMembers(storedPresent: Iterable<string>, current: string[], totalMember: number) {
  const before = new Set(storedPresent);
  const now = new Set(current);
  const joined = current.filter((id) => !before.has(id));
  const trusted = totalMember <= 0 || current.length >= totalMember * 0.9;
  const left = trusted ? [...before].filter((id) => !now.has(id)) : [];
  return { joined, left, trusted };
}

// ---------- Thống kê ----------

export type Bucket = "day" | "week" | "month";

export interface EventRow {
  user_id: string;
  user_name: string;
  kind: "join" | "leave" | "remove" | "block";
  via: string;
  actor_id: string;
  actor_name: string;
  at: number;
}

const ymdVN = (ts: number) => new Date(ts + VN_OFFSET).toISOString().slice(0, 10);

/** Nhãn nhóm thời gian theo giờ Việt Nam: ngày "2026-11-11", tuần = ngày thứ Hai, tháng "2026-11". */
export function bucketKey(ts: number, bucket: Bucket): string {
  if (bucket === "month") return ymdVN(ts).slice(0, 7);
  if (bucket === "day") return ymdVN(ts);
  const d = new Date(ts + VN_OFFSET);
  const dow = (d.getUTCDay() + 6) % 7; // thứ Hai = 0
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow)).toISOString().slice(0, 10);
}

/** Mọi nhãn từ from tới to (kể cả những kỳ không có sự kiện, để biểu đồ liền mạch). */
export function bucketRange(from: number, to: number, bucket: Bucket): string[] {
  const keys: string[] = [];
  let t = from;
  for (let i = 0; i < 800 && t <= to; i++) {
    const k = bucketKey(t, bucket);
    if (keys.at(-1) !== k) keys.push(k);
    t += 86_400_000;
  }
  const last = bucketKey(to, bucket);
  if (keys.at(-1) !== last) keys.push(last);
  return keys;
}

const isLeave = (k: EventRow["kind"]) => k !== "join";

export function computeStats(events: EventRow[], opts: { from: number; to: number; bucket: Bucket; now: number; currentMembers: number }) {
  const inRange = events.filter((e) => e.at >= opts.from && e.at <= opts.to);
  const series = new Map(bucketRange(opts.from, opts.to, opts.bucket).map((k) => [k, { key: k, joins: 0, leaves: 0 }]));
  const totals = { joins: 0, leaves: 0, net: 0, leaveBy: { leave: 0, remove: 0, block: 0 }, joinBy: { link: 0, added: 0, diff: 0 } };
  const adders = new Map<string, { name: string; count: number }>();
  for (const e of inRange) {
    const b = series.get(bucketKey(e.at, opts.bucket));
    if (e.kind === "join") {
      totals.joins++;
      if (b) b.joins++;
      const via = (e.via === "added" || e.via === "diff" ? e.via : "link") as "link" | "added" | "diff";
      totals.joinBy[via]++;
      if (e.via === "added" && e.actor_id) {
        const a = adders.get(e.actor_id) ?? { name: e.actor_name || e.actor_id, count: 0 };
        a.count++;
        adders.set(e.actor_id, a);
      }
    } else {
      totals.leaves++;
      if (b) b.leaves++;
      totals.leaveBy[e.kind]++;
    }
  }
  totals.net = totals.joins - totals.leaves;

  // Giữ chân: trong số người vào trong kỳ và đã đủ N ngày, bao nhiêu % chưa rời trong N ngày đó.
  const retention = (days: number) => {
    const ms = days * 86_400_000;
    const cohort = inRange.filter((e) => e.kind === "join" && e.at <= opts.now - ms);
    if (cohort.length === 0) return null;
    const stayed = cohort.filter(
      (j) => !events.some((x) => x.user_id === j.user_id && isLeave(x.kind) && x.at > j.at && x.at <= j.at + ms),
    ).length;
    return { cohort: cohort.length, stayed, percent: Math.round((stayed / cohort.length) * 100) };
  };

  return {
    currentMembers: opts.currentMembers,
    totals,
    series: [...series.values()],
    topAdders: [...adders.values()].sort((a, b) => b.count - a.count).slice(0, 5),
    retention: { d7: retention(7), d30: retention(30) },
  };
}

/** Dòng CSV an toàn cho Excel (dấu phẩy, ngoặc kép, xuống dòng; chặn công thức). */
export function csvRow(values: (string | number)[]): string {
  return values
    .map((v) => {
      let s = String(v);
      if (/^[=+\-@]/.test(s)) s = `'${s}`;
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(",");
}
