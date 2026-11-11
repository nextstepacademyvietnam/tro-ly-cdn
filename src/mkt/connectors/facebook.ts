import { addDays, dayRange, vnDay, vnMidnight } from "../dates.js";
import type { PostRow } from "../store.js";

/**
 * Fanpage Facebook qua Graph API (bản v26, như bộ script đo lường cũ của NSG).
 *
 * Số theo ngày:
 *  - views (page_media_view), engagement (page_post_engagements), page_views (page_views_total), follows (page_daily_follows):
 *    ngày = 10 ký tự đầu của end_time — đúng "nhãn ngày của Meta" (ngày kết thúc 15:00 giờ VN) mà Sheet đang dùng.
 *    Lượt xem có thể gồm cả lượt xem từ quảng cáo.
 *  - comments: bình luận theo ngày viết (giờ VN), bỏ bình luận của chính trang.
 *  - posts: số bài đăng theo ngày đăng (giờ VN).
 *  - followers: số người theo dõi lúc lấy số (ảnh chụp, ghi vào ngày lấy).
 */

export const GRAPH = "https://graph.facebook.com/v26.0";
export const FB_SCOPES = ["pages_show_list", "pages_read_engagement", "read_insights", "pages_read_user_content"];
const INSIGHT_METRICS: Record<string, string> = {
  page_media_view: "views",
  page_post_engagements: "engagement",
  page_views_total: "page_views",
  page_daily_follows: "follows",
};
/** Bài cũ hơn khoảng lấy số bao nhiêu ngày vẫn quét bình luận (bình luận mới trên bài cũ). */
const COMMENT_LOOKBACK_DAYS = 60;
const MAX_POSTS = 300;

type Fetch = typeof fetch;

export class GraphError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
  /** Token hết hạn, bị thu hồi hoặc mất quyền: phải nối lại. */
  get needsReconnect() {
    return this.code === 190 || this.code === 102 || this.code === 10 || this.code === 200;
  }
}

async function graph<T>(f: Fetch, pathOrUrl: string, params: Record<string, string> = {}): Promise<T> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${GRAPH}/${pathOrUrl}?${new URLSearchParams(params)}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await f(url, { signal: AbortSignal.timeout(60_000) });
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number } };
    if (res.ok && !body.error) return body as T;
    const code = body.error?.code;
    lastErr = new GraphError(body.error?.message ?? `Facebook trả lỗi ${res.status}`, code);
    // Quá tải tạm thời thì thử lại; lỗi quyền/token thì dừng ngay.
    if (![1, 2, 4, 17, 341].includes(code ?? 0) && res.status < 500) break;
    await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
  }
  throw lastErr;
}

// ---------- Đăng nhập (OAuth bằng app Meta của chính người dùng) ----------

export function fbAuthUrl(appId: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({ client_id: appId, redirect_uri: redirectUri, state, scope: FB_SCOPES.join(","), response_type: "code" });
  return `https://www.facebook.com/v26.0/dialog/oauth?${q}`;
}

/** Đổi mã đăng nhập lấy token người dùng dài hạn (~60 ngày); token trang lấy từ nó thì không hết hạn. */
export async function fbExchangeCode(f: Fetch, appId: string, appSecret: string, redirectUri: string, code: string): Promise<string> {
  const short = await graph<{ access_token: string }>(f, "oauth/access_token", { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code });
  const long = await graph<{ access_token: string }>(f, "oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: short.access_token,
  });
  return long.access_token;
}

export interface FbPage {
  id: string;
  name: string;
  token: string;
}

export async function fbPages(f: Fetch, userToken: string): Promise<FbPage[]> {
  const out: FbPage[] = [];
  let next: string | undefined = `${GRAPH}/me/accounts?${new URLSearchParams({ fields: "id,name,access_token", limit: "100", access_token: userToken })}`;
  while (next && out.length < 500) {
    const r: { data?: { id: string; name: string; access_token: string }[]; paging?: { next?: string } } = await graph(f, next);
    for (const p of r.data ?? []) out.push({ id: p.id, name: p.name, token: p.access_token });
    next = r.paging?.next;
  }
  return out;
}

/** Token dán tay: là token trang thì trả về đúng trang đó; là token người dùng thì trả về các trang người đó quản lý. */
export async function fbResolveToken(f: Fetch, token: string): Promise<FbPage[]> {
  try {
    const pages = await fbPages(f, token);
    if (pages.length) return pages;
  } catch {
    /* token trang không gọi được /me/accounts */
  }
  const me = await graph<{ id: string; name: string }>(f, "me", { fields: "id,name", access_token: token });
  return [{ id: me.id, name: me.name, token }];
}

// ---------- Lấy số ----------

export interface FbPull {
  daily: Record<string, [string, number | null][]>;
  posts: PostRow[];
  followers: number | null;
  pageName: string;
  /** Ngày mới nhất có lượt xem. */
  dataUntil: string;
}

export async function fbPull(f: Fetch, page: { id: string; token: string }, since: string, today: string): Promise<FbPull> {
  const tok = page.token;
  const info = await graph<{ name?: string; followers_count?: number }>(f, page.id, { fields: "name,followers_count", access_token: tok });

  // 1. Insights theo ngày, mỗi lần tối đa 90 ngày (Graph giới hạn 93).
  const daily: Record<string, [string, number | null][]> = {};
  for (const m of Object.values(INSIGHT_METRICS)) daily[m] = [];
  for (let start = since; start <= today; start = addDays(start, 90)) {
    const end = addDays(start, 90) < addDays(today, 1) ? addDays(start, 90) : addDays(today, 1);
    const r = await graph<{ data?: { name: string; values?: { end_time?: string; value?: unknown }[] }[] }>(f, `${page.id}/insights`, {
      metric: Object.keys(INSIGHT_METRICS).join(","),
      period: "day",
      since: start,
      until: end,
      access_token: tok,
    });
    for (const entry of r.data ?? []) {
      const metric = INSIGHT_METRICS[entry.name];
      if (!metric) continue;
      for (const v of entry.values ?? []) {
        if (!v.end_time || typeof v.value !== "number") continue;
        const day = v.end_time.slice(0, 10);
        if (day > today) continue; // ngày Meta đang đếm dở
        daily[metric]!.push([day, v.value]);
      }
    }
  }
  const viewDays = daily.views!.map(([d]) => d).sort();
  const dataUntil = viewDays.at(-1) ?? "";

  // 2. Bài đăng (lùi thêm để quét bình luận mới trên bài cũ).
  const scanFrom = addDays(since, -COMMENT_LOOKBACK_DAYS);
  const raw: { id: string; created_time: string; message?: string; permalink_url?: string; comments?: { summary?: { total_count?: number } }; reactions?: { summary?: { total_count?: number } } }[] = [];
  let next: string | undefined = `${GRAPH}/${page.id}/posts?${new URLSearchParams({
    fields: "id,created_time,message,permalink_url,comments.summary(true).limit(0),reactions.summary(true).limit(0)",
    since: String(Math.floor(vnMidnight(scanFrom) / 1000)),
    limit: "100",
    access_token: tok,
  })}`;
  while (next && raw.length < MAX_POSTS) {
    const r: { data?: typeof raw; paging?: { next?: string } } = await graph(f, next);
    raw.push(...(r.data ?? []));
    next = r.paging?.next;
  }

  // 3. Lượt xem từng bài (bài trong khoảng lấy số), 4 lượt gọi song song.
  const inWindow = raw.filter((p) => vnDay(Date.parse(p.created_time)) >= since);
  const views = new Map<string, number | null>();
  await pool(inWindow, 4, async (p) => {
    try {
      const r = await graph<{ data?: { values?: { value?: unknown }[] }[] }>(f, `${p.id}/insights`, { metric: "post_media_view", access_token: tok });
      const v = r.data?.[0]?.values?.[0]?.value;
      views.set(p.id, typeof v === "number" ? v : null);
    } catch {
      views.set(p.id, null);
    }
  });
  const posts: PostRow[] = inWindow.map((p) => ({
    kind: "facebook",
    postId: p.id,
    day: vnDay(Date.parse(p.created_time)),
    title: firstLine(p.message) || "(Bài không có chữ)",
    url: p.permalink_url ?? `https://www.facebook.com/${p.id}`,
    views: views.get(p.id) ?? null,
    comments: p.comments?.summary?.total_count ?? null,
    reactions: p.reactions?.summary?.total_count ?? null,
  }));

  // 4. Bình luận theo ngày viết, bỏ bình luận của chính trang.
  const commentCount = new Map<string, number>();
  await pool(
    raw.filter((p) => (p.comments?.summary?.total_count ?? 0) > 0),
    4,
    async (p) => {
      let url: string | undefined = `${GRAPH}/${p.id}/comments?${new URLSearchParams({ fields: "id,created_time,from", filter: "stream", limit: "100", access_token: tok })}`;
      let seen = 0;
      while (url && seen < 1000) {
        const r: { data?: { created_time: string; from?: { id?: string } }[]; paging?: { next?: string } } = await graph(f, url);
        for (const c of r.data ?? []) {
          seen++;
          if (c.from?.id === page.id) continue;
          const d = vnDay(Date.parse(c.created_time));
          if (d >= since && d <= today) commentCount.set(d, (commentCount.get(d) ?? 0) + 1);
        }
        url = r.paging?.next;
      }
    },
  );
  const postCount = new Map<string, number>();
  for (const p of posts) postCount.set(p.day, (postCount.get(p.day) ?? 0) + 1);
  // Lấy chạm trần MAX_POSTS: chỉ biết đủ bài từ ngày của bài cũ nhất trở đi; ngày trước đó để trống.
  const capped = raw.length >= MAX_POSTS;
  const knownFrom = capped ? raw.reduce((m, p) => (vnDay(Date.parse(p.created_time)) < m ? vnDay(Date.parse(p.created_time)) : m), today) : since;
  const countFrom = knownFrom > since ? addDays(knownFrom, 1) : since;
  const known = dayRange(since, today).filter((d) => d >= countFrom);
  daily.comments = known.map((d) => [d, commentCount.get(d) ?? 0]);
  daily.posts = known.map((d) => [d, postCount.get(d) ?? 0]);
  daily.followers = typeof info.followers_count === "number" ? [[today, info.followers_count]] : [];

  return { daily, posts, followers: info.followers_count ?? null, pageName: info.name ?? "", dataUntil };
}

function firstLine(s?: string): string {
  const t = (s ?? "").trim().split(/\n+/)[0] ?? "";
  return t.length > 160 ? `${t.slice(0, 157)}…` : t;
}

async function pool<T>(items: T[], size: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]!);
    }),
  );
}
