import { addDays, vnDay } from "./dates.js";
import { GraphError, fbPull } from "./connectors/facebook.js";
import { GoogleError, ytPull } from "./connectors/youtube.js";
import { DEFAULT_RULES, type LeadRules, PancakeError, pancakePull } from "./connectors/pancake.js";
import type { MktKind, MktStore } from "./store.js";

/** Lần nối đầu lấy lùi bao nhiêu ngày; các lần sau lấy lại mấy ngày gần nhất (Meta còn sửa số, YouTube trễ ~3 ngày). */
const BACKFILL_DAYS = 120;
const RECENT_DAYS: Partial<Record<MktKind, number>> = { facebook: 3, youtube: 7, pancake: 30 };
const DAILY_HOUR = 6;
const CHECK_EVERY_MS = 10 * 60_000;

interface Opts {
  fetch?: typeof fetch;
  /** Báo vào chuông (lỗi kết nối). */
  notify?: (text: string) => void;
  log?: (msg: string, extra?: object) => void;
  now?: () => number;
}

/** Lấy số các nền tảng đã nối: tự chạy mỗi sáng 06:00 (giờ máy), và khi người dùng bấm Làm mới. */
export class MktRunner {
  private readonly running = new Map<MktKind, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private lastAutoDay = "";

  constructor(
    private readonly store: MktStore,
    private readonly o: Opts = {},
  ) {}

  private now() {
    return this.o.now?.() ?? Date.now();
  }

  isRunning(kind: MktKind) {
    return this.running.has(kind);
  }

  /** Lấy số một nền tảng; đang chạy thì trả về lượt đang chạy. */
  pull(kind: MktKind): Promise<void> {
    const cur = this.running.get(kind);
    if (cur) return cur;
    const p = this.doPull(kind).finally(() => this.running.delete(kind));
    this.running.set(kind, p);
    return p;
  }

  async pullAll() {
    for (const c of this.store.connections()) if (c.hasSecret && c.status !== "off") await this.pull(c.kind).catch(() => undefined);
  }

  private async doPull(kind: MktKind) {
    const conn = this.store.connection(kind);
    const today = vnDay(this.now());
    const since = addDays(today, conn.pulledAt ? -(RECENT_DAYS[kind] ?? 3) : -BACKFILL_DAYS);
    const f = this.o.fetch ?? fetch;
    try {
      if (kind === "facebook") {
        const s = this.store.secret<{ pageId?: string; pageToken?: string }>("facebook");
        if (!s?.pageId || !s.pageToken) throw new Error("Chưa chọn trang Facebook");
        const r = await fbPull(f, { id: s.pageId, token: s.pageToken }, since, today);
        for (const [metric, rows] of Object.entries(r.daily)) this.store.putDaily("facebook", metric, rows, this.now());
        this.store.upsertPosts(r.posts, this.now());
        this.store.save("facebook", {
          status: "ok",
          error: "",
          label: r.pageName || conn.label,
          pulledAt: this.now(),
          dataUntil: r.dataUntil > conn.dataUntil ? r.dataUntil : conn.dataUntil || r.dataUntil,
        });
        this.store.addRun("facebook", true, `Lấy ${r.posts.length} bài, số từ ${since}`, this.now());
        return;
      }
      if (kind === "youtube") {
        const s = this.store.secret<{ clientId?: string; clientSecret?: string; refreshToken?: string }>("youtube");
        if (!s?.clientId || !s.clientSecret || !s.refreshToken) throw new Error("Chưa đăng nhập Google của chủ kênh");
        const r = await ytPull(f, { clientId: s.clientId, clientSecret: s.clientSecret }, s.refreshToken, since, today);
        for (const [metric, rows] of Object.entries(r.daily)) this.store.putDaily("youtube", metric, rows, this.now());
        this.store.upsertPosts(r.posts, this.now());
        this.store.save("youtube", {
          status: "ok",
          error: "",
          label: r.channelTitle || conn.label,
          meta: { ...conn.meta, channelId: r.channelId, channelTitle: r.channelTitle },
          pulledAt: this.now(),
          dataUntil: r.dataUntil > conn.dataUntil ? r.dataUntil : conn.dataUntil || r.dataUntil,
        });
        this.store.addRun("youtube", true, `Lấy ${r.posts.length} video, số từ ${since}${r.dataUntil ? `, YouTube có số tới ${r.dataUntil}` : ""}`, this.now());
        return;
      }
      if (kind === "pancake") {
        const s = this.store.secret<{ apiKey?: string; shopId?: string }>("pancake");
        if (!s?.apiKey || !s.shopId) throw new Error("Chưa nhập API key và Shop ID của Pancake");
        const rules = (conn.meta.rules as LeadRules | undefined) ?? DEFAULT_RULES;
        const r = await pancakePull(f, { apiKey: s.apiKey, shopId: s.shopId }, rules, since, today);
        for (const [metric, rows] of Object.entries(r.daily)) this.store.putDaily("pancake", metric, rows, this.now());
        this.store.save("pancake", { status: "ok", error: "", pulledAt: this.now(), dataUntil: r.dataUntil });
        this.store.addRun("pancake", true, `Đọc ${r.rows} bản ghi, số từ ${since}`, this.now());
        return;
      }
      throw new Error("Nền tảng này chưa hỗ trợ trong bản này");
    } catch (err) {
      const reconnect = (err instanceof GraphError || err instanceof GoogleError || err instanceof PancakeError) && err.needsReconnect;
      const message = reconnect ? "Khoá đăng nhập hết hạn hoặc mất quyền — bấm Nối lại" : `Không lấy được số: ${(err as Error).message}`;
      const wasOk = this.store.connection(kind).status !== "error";
      this.store.save(kind, { status: "error", error: message });
      this.store.addRun(kind, false, message, this.now());
      if (wasOk) this.o.notify?.(`MKT · ${NAMES[kind]}: ${message}`);
      this.o.log?.("Lỗi lấy số MKT", { kind, err: (err as Error).message });
      throw err;
    }
  }

  start() {
    if (this.timer) return;
    const tick = () => {
      const now = new Date(this.now());
      const day = vnDay(now.getTime());
      // Lần bật đầu tiên: số cũ hơn 24 giờ thì lấy luôn; sau đó mỗi ngày một lần từ 06:00 giờ máy.
      const stale = this.store.connections().some((c) => c.hasSecret && c.status !== "off" && this.now() - c.pulledAt > 24 * 3_600_000);
      if ((now.getHours() >= DAILY_HOUR && this.lastAutoDay !== day) || (stale && !this.lastAutoDay)) {
        this.lastAutoDay = now.getHours() >= DAILY_HOUR ? day : "khoi-dong";
        void this.pullAll();
      }
    };
    setTimeout(tick, 30_000).unref();
    this.timer = setInterval(tick, CHECK_EVERY_MS);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const NAMES: Record<MktKind, string> = {
  facebook: "Facebook",
  youtube: "YouTube",
  tiktok: "TikTok",
  meta_ads: "Quảng cáo Meta",
  pancake: "Pancake CRM",
  gsheet: "Google Sheet",
};
