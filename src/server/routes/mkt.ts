import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { addDays, isDay, vnDay } from "../../mkt/dates.js";
import { type FbPage, fbAuthUrl, fbExchangeCode, fbPages, fbResolveToken } from "../../mkt/connectors/facebook.js";
import { NAMES, type MktRunner } from "../../mkt/runner.js";
import { DEFAULT_RULES, type LeadRules, PancakeError, pancakeCheck } from "../../mkt/connectors/pancake.js";
import { googleAuthUrl, googleExchange, googleAccessToken, parseClientJson, pkcePair, ytChannel } from "../../mkt/connectors/youtube.js";
import { type MktStore, isMktKind } from "../../mkt/store.js";
import { SUM_METRICS, dailyTable, summarize } from "../../mkt/summary.js";

/** Nền tảng đã làm trong bản này; các nền tảng khác hiện "Sắp có" trên màn Kết nối. */
const AVAILABLE = new Set(["facebook", "youtube", "pancake"]);
const TTL_MS = 15 * 60_000;

export interface MktDeps {
  store: MktStore;
  runner: MktRunner;
  fetch?: typeof fetch;
}

/** Đường dẫn công khai (không cần cookie): Facebook chuyển về đây sau khi đăng nhập — cookie SameSite=Strict không đi theo. */
export const MKT_PUBLIC_PREFIX = "/api/mkt/oauth/";

export function registerMktRoutes(app: FastifyInstance, deps: MktDeps) {
  const { store, runner } = deps;
  const f = deps.fetch ?? fetch;
  // Mã chống giả cho lần đăng nhập (state) và danh sách trang chờ chọn: chỉ giữ trong bộ nhớ, 15 phút.
  const states = new Map<string, { at: number; redirect: string; provider: "facebook" | "youtube"; verifier?: string }>();
  const pending = new Map<string, { at: number; pages: FbPage[] }>();
  const sweep = () => {
    const now = Date.now();
    for (const [k, v] of states) if (now - v.at > TTL_MS) states.delete(k);
    for (const [k, v] of pending) if (now - v.at > TTL_MS) pending.delete(k);
  };
  const bad = (reply: FastifyReply, msg: string, code = 400) => reply.code(code).send({ error: msg });
  const origin = (req: FastifyRequest) => `${req.protocol}://${req.headers.host ?? "localhost:3000"}`;

  const view = () =>
    store.connections().map((c) => ({
      kind: c.kind,
      name: NAMES[c.kind],
      available: AVAILABLE.has(c.kind),
      status: c.status,
      error: c.error,
      label: c.label,
      dataUntil: c.dataUntil,
      pulledAt: c.pulledAt,
      connectedAt: c.connectedAt,
      running: runner.isRunning(c.kind),
      hasApp: c.kind === "facebook" ? Boolean(c.meta.appId) : c.kind === "youtube" ? Boolean(c.meta.hasClient) : undefined,
      appId: c.kind === "facebook" ? String(c.meta.appId ?? "") : undefined,
    }));

  const connectPage = (page: FbPage) => {
    const s = store.secret<Record<string, unknown>>("facebook") ?? {};
    const meta = store.connection("facebook").meta;
    store.save("facebook", {
      label: page.name,
      status: "ok",
      error: "",
      secret: { ...s, pageId: page.id, pageToken: page.token },
      meta: { ...meta, pageId: page.id, pageName: page.name },
      connectedAt: Date.now(),
      pulledAt: 0,
    });
    void runner.pull("facebook").catch(() => undefined);
  };
  /** Một trang thì nối luôn; nhiều trang thì cất lại chờ người dùng chọn. */
  const offerPages = (pages: FbPage[]) => {
    if (!pages.length) throw new Error("Tài khoản này không quản lý trang Facebook nào");
    if (pages.length === 1) {
      connectPage(pages[0]!);
      return { connected: pages[0]!.name };
    }
    const id = crypto.randomBytes(12).toString("hex");
    pending.set(id, { at: Date.now(), pages });
    return { pending: id, pages: pages.map((p) => ({ id: p.id, name: p.name })) };
  };

  app.get("/api/mkt/connections", async () => ({ connections: view(), runs: store.runs(undefined, 20) }));

  // ---------- Facebook ----------
  app.post<{ Body: { appId?: string; appSecret?: string } }>("/api/mkt/facebook/app", async (req, reply) => {
    const appId = String(req.body?.appId ?? "").trim();
    const appSecret = String(req.body?.appSecret ?? "").trim();
    if (!/^\d{5,20}$/.test(appId)) return bad(reply, "App ID là dãy số, lấy ở trang Cài đặt cơ bản của app Meta");
    const cur = store.secret<Record<string, unknown>>("facebook") ?? {};
    if (!appSecret && !cur.appSecret) return bad(reply, "Cần App Secret (khoá bí mật của app)");
    const conn = store.connection("facebook");
    store.save("facebook", { secret: { ...cur, appId, ...(appSecret ? { appSecret } : {}) }, meta: { ...conn.meta, appId } });
    return { ok: true };
  });

  app.get("/api/mkt/facebook/login", async (req, reply) => {
    sweep();
    const s = store.secret<{ appId?: string; appSecret?: string }>("facebook");
    if (!s?.appId || !s.appSecret) return bad(reply, "Nhập App ID và App Secret trước");
    const state = crypto.randomBytes(16).toString("hex");
    const redirect = `${origin(req)}${MKT_PUBLIC_PREFIX}facebook/callback`;
    states.set(state, { at: Date.now(), redirect, provider: "facebook" });
    return { url: fbAuthUrl(s.appId, redirect, state), redirect };
  });

  app.get<{ Querystring: { code?: string; state?: string; error_description?: string } }>(`${MKT_PUBLIC_PREFIX}facebook/callback`, async (req, reply) => {
    sweep();
    const back = (params: Record<string, string>) => reply.redirect(`/?${new URLSearchParams({ trang: "mkt-ketnoi", ...params })}`);
    const st = req.query.state ? states.get(req.query.state) : undefined;
    if (!st || st.provider !== "facebook") return back({ fb: "loi", tb: "Phiên đăng nhập đã hết hạn, bấm Đăng nhập Facebook lại" });
    states.delete(req.query.state!);
    if (!req.query.code) return back({ fb: "loi", tb: req.query.error_description ?? "Bạn chưa cho phép app đọc trang" });
    try {
      const s = store.secret<{ appId: string; appSecret: string }>("facebook")!;
      const userToken = await fbExchangeCode(f, s.appId, s.appSecret, st.redirect, req.query.code);
      const r = offerPages(await fbPages(f, userToken));
      return back("pending" in r ? { fb: "chon", ma: r.pending! } : { fb: "ok" });
    } catch (err) {
      return back({ fb: "loi", tb: (err as Error).message });
    }
  });

  app.post<{ Body: { token?: string } }>("/api/mkt/facebook/token", async (req, reply) => {
    const token = cleanToken(String(req.body?.token ?? ""));
    if (token.length < 20) return bad(reply, "Token không hợp lệ");
    try {
      return offerPages(await fbResolveToken(f, token));
    } catch (err) {
      return bad(reply, `Facebook không nhận token này: ${(err as Error).message}`);
    }
  });

  app.get<{ Params: { id: string } }>("/api/mkt/facebook/pending/:id", async (req, reply) => {
    const p = pending.get(req.params.id);
    if (!p) return bad(reply, "Danh sách trang đã hết hạn, đăng nhập lại", 404);
    return { pages: p.pages.map((x) => ({ id: x.id, name: x.name })) };
  });

  app.post<{ Body: { pending?: string; pageId?: string } }>("/api/mkt/facebook/choose", async (req, reply) => {
    const p = pending.get(String(req.body?.pending ?? ""));
    const page = p?.pages.find((x) => x.id === req.body?.pageId);
    if (!page) return bad(reply, "Danh sách trang đã hết hạn, đăng nhập lại", 404);
    pending.delete(req.body!.pending!);
    connectPage(page);
    return { connected: page.name };
  });

  // ---------- YouTube (OAuth client "Ứng dụng máy tính" của chính người dùng) ----------
  app.post<{ Body: { json?: string } }>("/api/mkt/youtube/client", async (req, reply) => {
    let client;
    try {
      client = parseClientJson(String(req.body?.json ?? ""));
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
    const cur = store.secret<Record<string, unknown>>("youtube") ?? {};
    const conn = store.connection("youtube");
    // Đổi client thì khoá cũ không dùng được nữa.
    const same = cur.clientId === client.clientId;
    store.save("youtube", {
      secret: { ...(same ? cur : {}), clientId: client.clientId, clientSecret: client.clientSecret },
      meta: { ...conn.meta, hasClient: true },
      ...(same ? {} : { status: "off" as const }),
    });
    return { ok: true };
  });

  app.get("/api/mkt/youtube/login", async (req, reply) => {
    sweep();
    const s = store.secret<{ clientId?: string; clientSecret?: string }>("youtube");
    if (!s?.clientId || !s.clientSecret) return bad(reply, "Tải file JSON client của Google Cloud lên trước");
    const state = crypto.randomBytes(16).toString("hex");
    const { verifier, challenge } = pkcePair();
    // Client "Ứng dụng máy tính" của Google chỉ nhận địa chỉ trên chính máy (localhost/127.0.0.1).
    const redirect = `${origin(req)}${MKT_PUBLIC_PREFIX}youtube/callback`;
    states.set(state, { at: Date.now(), redirect, provider: "youtube", verifier });
    return { url: googleAuthUrl({ clientId: s.clientId, clientSecret: s.clientSecret }, redirect, state, challenge), redirect };
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(`${MKT_PUBLIC_PREFIX}youtube/callback`, async (req, reply) => {
    sweep();
    const back = (params: Record<string, string>) => reply.redirect(`/?${new URLSearchParams({ trang: "mkt-ketnoi", ...params })}`);
    const st = req.query.state ? states.get(req.query.state) : undefined;
    if (!st || st.provider !== "youtube") return back({ yt: "loi", tb: "Phiên đăng nhập đã hết hạn, bấm Đăng nhập Google lại" });
    states.delete(req.query.state!);
    if (!req.query.code) return back({ yt: "loi", tb: req.query.error === "access_denied" ? "Bạn chưa cho phép app đọc số liệu kênh" : (req.query.error ?? "Google không trả mã đăng nhập") });
    try {
      const s = store.secret<{ clientId: string; clientSecret: string }>("youtube")!;
      const client = { clientId: s.clientId, clientSecret: s.clientSecret };
      const refreshToken = await googleExchange(f, client, st.redirect, req.query.code, st.verifier!);
      const ch = await ytChannel(f, await googleAccessToken(f, client, refreshToken));
      const conn = store.connection("youtube");
      store.save("youtube", {
        label: ch.snippet?.title ?? "",
        status: "ok",
        error: "",
        secret: { ...s, refreshToken },
        meta: { ...conn.meta, channelId: ch.id, channelTitle: ch.snippet?.title ?? "" },
        connectedAt: Date.now(),
        pulledAt: 0,
      });
      void runner.pull("youtube").catch(() => undefined);
      return back({ yt: "ok" });
    } catch (err) {
      return back({ yt: "loi", tb: (err as Error).message });
    }
  });

  // ---------- Pancake CRM (lead) ----------
  app.post<{ Body: { apiKey?: string; shopId?: string } }>("/api/mkt/pancake", async (req, reply) => {
    const cur = store.secret<{ apiKey?: string; shopId?: string }>("pancake") ?? {};
    const apiKey = cleanToken(String(req.body?.apiKey ?? "")) || cur.apiKey || "";
    const shopId = String(req.body?.shopId ?? "").trim() || cur.shopId || "";
    if (!apiKey || !/^\d{3,20}$/.test(shopId)) return bad(reply, "Cần API key và Shop ID (dãy số) của Pancake POS");
    const conn = store.connection("pancake");
    const rules = (conn.meta.rules as LeadRules | undefined) ?? DEFAULT_RULES;
    try {
      await pancakeCheck(f, { apiKey, shopId }, rules.contactTable);
    } catch (err) {
      return bad(reply, err instanceof PancakeError ? err.message : `Không gọi được Pancake: ${(err as Error).message}`);
    }
    store.save("pancake", {
      label: `Shop ${shopId}`,
      status: "ok",
      error: "",
      secret: { apiKey, shopId },
      meta: { ...conn.meta, shopId, rules },
      connectedAt: Date.now(),
      pulledAt: 0,
    });
    void runner.pull("pancake").catch(() => undefined);
    return { ok: true };
  });

  app.get("/api/mkt/pancake/rules", async () => ({ rules: (store.connection("pancake").meta.rules as LeadRules | undefined) ?? DEFAULT_RULES, defaults: DEFAULT_RULES }));

  app.put<{ Body: { rules?: LeadRules } }>("/api/mkt/pancake/rules", async (req, reply) => {
    const r = req.body?.rules;
    const ok =
      r && typeof r.contactTable === "string" && r.contactTable.trim() && typeof r.workshopTable === "string" && Array.isArray(r.founderTitles) && r.channels && typeof r.channels === "object" &&
      Object.values(r.channels).every((c) => c && Array.isArray(c.prefix) && Array.isArray(c.exact));
    if (!ok) return bad(reply, "Luật không hợp lệ");
    const low = (a: unknown[]) => a.map((x) => String(x).normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase()).filter(Boolean);
    const rules: LeadRules = {
      contactTable: r.contactTable.trim(),
      workshopTable: r.workshopTable.trim(),
      founderTitles: low(r.founderTitles),
      channels: Object.fromEntries(Object.entries(r.channels).map(([k, v]) => [k, { prefix: low(v.prefix), exact: low(v.exact) }])),
    };
    const conn = store.connection("pancake");
    store.save("pancake", { meta: { ...conn.meta, rules }, pulledAt: 0 });
    if (conn.status !== "off") void runner.pull("pancake").catch(() => undefined);
    return { rules };
  });

  // ---------- Chung ----------
  app.post<{ Body: { kind?: string } }>("/api/mkt/refresh", async (req, reply) => {
    const kind = req.body?.kind;
    if (kind !== undefined && !isMktKind(kind)) return bad(reply, "Không có nền tảng này");
    if (isMktKind(kind)) void runner.pull(kind).catch(() => undefined);
    else void runner.pullAll();
    return { ok: true, connections: view() };
  });

  app.delete<{ Params: { kind: string } }>("/api/mkt/connections/:kind", async (req, reply) => {
    if (!isMktKind(req.params.kind)) return bad(reply, "Không có nền tảng này");
    store.disconnect(req.params.kind);
    return { ok: true };
  });

  const range = (q: { from?: string; to?: string }) => {
    const to = isDay(q.to) ? q.to : addDays(vnDay(Date.now()), -1);
    const from = isDay(q.from) && q.from <= to ? q.from : addDays(to, -6);
    return { from, to };
  };

  app.get<{ Querystring: { from?: string; to?: string } }>("/api/mkt/summary", async (req) => {
    const { from, to } = range(req.query);
    return summarize(store, from, to);
  });

  app.get<{ Querystring: { kind?: string; from?: string; to?: string } }>("/api/mkt/daily", async (req, reply) => {
    if (!isMktKind(req.query.kind)) return bad(reply, "Thiếu nền tảng");
    const { from, to } = range(req.query);
    return { kind: req.query.kind, metrics: SUM_METRICS[req.query.kind] ?? [], rows: dailyTable(store, req.query.kind, from, to) };
  });

  app.get<{ Querystring: { kind?: string; from?: string; to?: string; sort?: string; limit?: string } }>("/api/mkt/posts", async (req) => {
    const { from, to } = range(req.query);
    const kind = isMktKind(req.query.kind) ? req.query.kind : undefined;
    return { posts: store.topPosts({ from, to, kind, sort: req.query.sort === "comments" ? "comments" : "views", limit: Math.min(50, Number(req.query.limit) || 10) }) };
  });

  app.get<{ Querystring: { kind?: string; from?: string; to?: string } }>("/api/mkt/daily.csv", async (req, reply) => {
    if (!isMktKind(req.query.kind)) return bad(reply, "Thiếu nền tảng");
    const { from, to } = range(req.query);
    const metrics = SUM_METRICS[req.query.kind] ?? [];
    const rows = dailyTable(store, req.query.kind, from, to);
    const csv = [["Ngày", ...metrics].join(","), ...rows.map((r) => [r.day, ...metrics.map((m) => (r as Record<string, unknown>)[m] ?? "")].join(","))].join("\r\n");
    reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="mkt-${req.query.kind}-${from}-${to}.csv"`);
    return `﻿${csv}`;
  });

}

/** Gọt những thứ hay chép thừa khi dán token: "TEN_BIEN=", dấu ngoặc, "Bearer ", khoảng trắng, xuống dòng. */
export function cleanToken(raw: string): string {
  return raw
    .trim()
    .replace(/^[A-Z0-9_]+\s*=\s*/, "")
    .replace(/^Bearer\s+/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, "");
}
