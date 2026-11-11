import crypto from "node:crypto";
import { dayRange, vnDay } from "../dates.js";
import type { PostRow } from "../store.js";

/**
 * Kênh YouTube qua YouTube Analytics v2 + Data API v3 (như bộ script đo lường cũ của NSG).
 *
 * Số theo ngày (ngày của YouTube Analytics là giờ Thái Bình Dương, giữ nguyên như Sheet đang dùng):
 *  views, comments, likes, watch_minutes, follows (đăng ký mới trừ huỷ). YouTube trễ ~3 ngày:
 *  ngày chưa báo số thì để trống, không ghi 0.
 *  posts: video công khai đăng trong ngày (giờ VN), từ danh sách tải lên của kênh.
 *  followers: số người đăng ký lúc lấy số.
 *
 * Đăng nhập: OAuth client loại "Ứng dụng máy tính" của chính người dùng (Google Cloud), PKCE,
 * chuyển hướng về http://localhost:<cổng>. Chỉ xin quyền đọc.
 */

export const YT_SCOPES = ["https://www.googleapis.com/auth/yt-analytics.readonly", "https://www.googleapis.com/auth/youtube.readonly"];
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DATA = "https://www.googleapis.com/youtube/v3";
const ANALYTICS = "https://youtubeanalytics.googleapis.com/v2/reports";

type Fetch = typeof fetch;

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

export class GoogleError extends Error {
  constructor(
    message: string,
    readonly reconnect = false,
  ) {
    super(message);
  }
  get needsReconnect() {
    return this.reconnect;
  }
}

/** Đọc file JSON client tải từ Google Cloud (loại "installed" hoặc "web"). */
export function parseClientJson(text: string): GoogleClient {
  let j: { installed?: Record<string, string>; web?: Record<string, string> };
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error("Không đọc được file: hãy chọn đúng file JSON tải về từ Google Cloud (Thông tin xác thực → Tải JSON)");
  }
  const c = j.installed ?? j.web;
  if (!c?.client_id || !c.client_secret) throw new Error("File JSON thiếu client_id hoặc client_secret");
  return { clientId: c.client_id, clientSecret: c.client_secret };
}

export function pkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function googleAuthUrl(client: GoogleClient, redirectUri: string, state: string, challenge: string, scopes = YT_SCOPES): string {
  const q = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    state,
    access_type: "offline",
    prompt: "consent",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

async function tokenCall(f: Fetch, body: Record<string, string>) {
  const res = await f(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body), signal: AbortSignal.timeout(30_000) });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; error?: string; error_description?: string };
  if (!res.ok || !j.access_token) {
    // invalid_grant: quyền bị thu hồi, hết hạn (app Google để chế độ Testing chỉ giữ 7 ngày), hoặc đổi mật khẩu.
    throw new GoogleError(j.error_description ?? j.error ?? `Google trả lỗi ${res.status}`, j.error === "invalid_grant" || j.error === "invalid_client");
  }
  return j;
}

export async function googleExchange(f: Fetch, client: GoogleClient, redirectUri: string, code: string, verifier: string): Promise<string> {
  const j = await tokenCall(f, { client_id: client.clientId, client_secret: client.clientSecret, code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirectUri });
  if (!j.refresh_token) throw new Error("Google không trả khoá dài hạn — vào myaccount.google.com/permissions gỡ quyền của app rồi đăng nhập lại");
  return j.refresh_token;
}

export async function googleAccessToken(f: Fetch, client: GoogleClient, refreshToken: string): Promise<string> {
  const j = await tokenCall(f, { client_id: client.clientId, client_secret: client.clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" });
  return j.access_token!;
}

async function gget<T>(f: Fetch, url: string, token: string): Promise<T> {
  const res = await f(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
  const j = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number } };
  if (!res.ok || j.error) throw new GoogleError(j.error?.message ?? `YouTube trả lỗi ${res.status}`, res.status === 401 || res.status === 403);
  return j as T;
}

export interface YtPull {
  daily: Record<string, [string, number | null][]>;
  posts: PostRow[];
  channelId: string;
  channelTitle: string;
  followers: number | null;
  dataUntil: string;
}

export async function ytChannel(f: Fetch, token: string) {
  const r = await gget<{ items?: { id: string; snippet?: { title?: string }; contentDetails?: { relatedPlaylists?: { uploads?: string } }; statistics?: { subscriberCount?: string } }[] }>(
    f,
    `${DATA}/channels?part=snippet,contentDetails,statistics&mine=true`,
    token,
  );
  const ch = r.items?.[0];
  if (!ch) throw new GoogleError("Tài khoản Google này không có kênh YouTube — đăng nhập bằng tài khoản chủ kênh", true);
  return ch;
}

export async function ytPull(f: Fetch, client: GoogleClient, refreshToken: string, since: string, today: string): Promise<YtPull> {
  const token = await googleAccessToken(f, client, refreshToken);
  const ch = await ytChannel(f, token);

  // 1. Số theo ngày.
  const q = new URLSearchParams({
    ids: "channel==MINE",
    startDate: since,
    endDate: today,
    metrics: "views,comments,likes,subscribersGained,subscribersLost,estimatedMinutesWatched",
    dimensions: "day",
    sort: "day",
  });
  const rep = await gget<{ rows?: (string | number)[][] }>(f, `${ANALYTICS}?${q}`, token);
  const reported = new Map<string, number[]>();
  for (const row of rep.rows ?? []) reported.set(String(row[0]), row.slice(1).map(Number));
  const days = dayRange(since, today);
  const col = (i: number) => days.map((d): [string, number | null] => [d, reported.get(d)?.[i] ?? null]);
  const daily: Record<string, [string, number | null][]> = {
    views: col(0),
    comments: col(1),
    likes: col(2),
    follows: days.map((d) => {
      const r = reported.get(d);
      return [d, r ? r[3]! - r[4]! : null];
    }),
    watch_minutes: col(5),
  };
  const dataUntil = [...reported.keys()].sort().at(-1) ?? "";

  // 2. Video công khai đăng trong khoảng (giờ VN), mới nhất trước.
  const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
  const vids: { id: string; day: string }[] = [];
  let pageToken = "";
  while (uploads) {
    const r = await gget<{ items?: { contentDetails?: { videoId?: string; videoPublishedAt?: string }; status?: { privacyStatus?: string } }[]; nextPageToken?: string }>(
      f,
      `${DATA}/playlistItems?${new URLSearchParams({ part: "contentDetails,status", playlistId: uploads, maxResults: "50", ...(pageToken ? { pageToken } : {}) })}`,
      token,
    );
    let older = false;
    for (const it of r.items ?? []) {
      const at = it.contentDetails?.videoPublishedAt;
      if (!at || !it.contentDetails?.videoId) continue;
      if (it.status?.privacyStatus !== "public") continue; // video không công khai (ghi hình workshop, nháp) không tính là bài
      const day = vnDay(Date.parse(at));
      if (day < since) {
        older = true;
        continue;
      }
      vids.push({ id: it.contentDetails.videoId, day });
    }
    if (older || !r.nextPageToken) break;
    pageToken = r.nextPageToken;
  }
  const postCount = new Map<string, number>();
  for (const v of vids) postCount.set(v.day, (postCount.get(v.day) ?? 0) + 1);
  daily.posts = days.map((d) => [d, postCount.get(d) ?? 0]);

  // 3. Lượt xem, bình luận từng video (top video).
  const posts: PostRow[] = [];
  for (let i = 0; i < vids.length; i += 50) {
    const batch = vids.slice(i, i + 50);
    const r = await gget<{ items?: { id: string; snippet?: { title?: string }; statistics?: { viewCount?: string; commentCount?: string; likeCount?: string } }[] }>(
      f,
      `${DATA}/videos?part=snippet,statistics&id=${batch.map((v) => v.id).join(",")}`,
      token,
    );
    for (const v of r.items ?? []) {
      const num = (s?: string) => (s === undefined ? null : Number(s));
      posts.push({
        kind: "youtube",
        postId: v.id,
        day: batch.find((b) => b.id === v.id)?.day ?? today,
        title: v.snippet?.title ?? "(Video không tên)",
        url: `https://www.youtube.com/watch?v=${v.id}`,
        views: num(v.statistics?.viewCount),
        comments: num(v.statistics?.commentCount),
        reactions: num(v.statistics?.likeCount),
      });
    }
  }

  const subs = ch.statistics?.subscriberCount;
  daily.followers = subs === undefined ? [] : [[today, Number(subs)]];
  return { daily, posts, channelId: ch.id, channelTitle: ch.snippet?.title ?? "", followers: subs === undefined ? null : Number(subs), dataUntil };
}
