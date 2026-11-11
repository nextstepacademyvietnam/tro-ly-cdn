import type { FastifyInstance } from "fastify";
import type { GroupTracker } from "../../groups/tracker.js";
import { type Bucket, csvRow } from "../../groups/logic.js";

const KIND_LABEL: Record<string, string> = { join: "Vào nhóm", leave: "Tự rời", remove: "Bị mời ra", block: "Bị chặn" };
const VIA_LABEL: Record<string, string> = { link: "Tự vào (link / được duyệt)", added: "Được thêm vào", diff: "Phát hiện khi đối chiếu", "": "" };

/** API nhóm Zalo của tài khoản đang chọn (header x-cdn-account, xem routes/zalo.ts). */
export function registerGroupRoutes(app: FastifyInstance, groups: GroupTracker) {
  const fail = (err: unknown, code = 409) => Object.assign(new Error((err as Error).message), { statusCode: code });
  const need = (accountId: number, groupId: string) => {
    if (!groups.group(accountId, groupId)) throw fail(new Error("Nhóm chưa được theo dõi"), 404);
  };
  const range = (q: { from?: string; to?: string; bucket?: string }) => {
    const now = Date.now();
    const to = Number(q.to) || now;
    const from = Number(q.from) || to - 30 * 86_400_000;
    const bucket: Bucket = q.bucket === "week" || q.bucket === "month" ? q.bucket : "day";
    if (from > to) throw fail(new Error("Khoảng ngày không hợp lệ"), 400);
    return { from, to, bucket };
  };

  app.get("/api/groups/scan", async (req) => {
    try {
      return { groups: await groups.scan(req.accountId) };
    } catch (err) {
      throw fail(err);
    }
  });

  app.get("/api/groups", async (req) => {
    const now = Date.now();
    return {
      groups: groups.tracked(req.accountId).map((g) => {
        const week = groups.events(req.accountId, g.group_id, { from: now - 7 * 86_400_000 });
        return {
          id: g.group_id,
          name: g.name,
          memberCount: g.member_count,
          trackedAt: g.tracked_at,
          reconciledAt: g.reconciled_at,
          joins7d: week.filter((e) => e.kind === "join").length,
          leaves7d: week.filter((e) => e.kind !== "join").length,
          welcomeOn: groups.welcome(req.accountId, g.group_id).enabled,
        };
      }),
    };
  });

  app.post<{ Params: { id: string }; Body: { on?: boolean } }>("/api/groups/:id/track", async (req) => {
    try {
      if (req.body?.on === false) {
        groups.untrack(req.accountId, req.params.id);
        return { ok: true };
      }
      const g = await groups.track(req.accountId, req.params.id);
      return { ok: true, group: { id: g.group_id, name: g.name, memberCount: g.member_count } };
    } catch (err) {
      throw fail(err);
    }
  });

  app.post<{ Params: { id: string } }>("/api/groups/:id/reconcile", async (req) => {
    need(req.accountId, req.params.id);
    const [r] = await groups.reconcile(req.accountId, req.params.id);
    if (!r) throw fail(new Error("Chưa đối chiếu được (Zalo chưa kết nối hoặc không đọc được nhóm)"));
    return r;
  });

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string; bucket?: string } }>("/api/groups/:id/stats", async (req) => {
    need(req.accountId, req.params.id);
    return groups.stats(req.accountId, req.params.id, range(req.query));
  });

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string; limit?: string } }>("/api/groups/:id/events", async (req) => {
    need(req.accountId, req.params.id);
    const { from, to } = range(req.query);
    return { events: groups.events(req.accountId, req.params.id, { from, to, limit: Math.min(Number(req.query.limit) || 500, 5000) }) };
  });

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>("/api/groups/:id/events.csv", async (req, reply) => {
    need(req.accountId, req.params.id);
    const { from, to } = range(req.query);
    const fmt = new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", dateStyle: "short", timeStyle: "short" });
    const lines = [csvRow(["Thời gian", "Sự kiện", "Tên", "Mã Zalo", "Cách vào", "Người thực hiện"])];
    for (const e of groups.events(req.accountId, req.params.id, { from, to }).reverse()) {
      lines.push(csvRow([fmt.format(e.at), KIND_LABEL[e.kind] ?? e.kind, e.user_name, e.user_id, VIA_LABEL[e.via] ?? e.via, e.actor_name || e.actor_id]));
    }
    const name = (groups.group(req.accountId, req.params.id)?.name || "nhom").replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 40);
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${name}-vao-roi.csv`)}`);
    // BOM để Excel đọc đúng tiếng Việt.
    return `﻿${lines.join("\r\n")}\r\n`;
  });

  app.get<{ Params: { id: string } }>("/api/groups/:id/members", async (req) => {
    need(req.accountId, req.params.id);
    return { members: groups.members(req.accountId, req.params.id) };
  });

  app.get<{ Params: { id: string } }>("/api/groups/:id/welcome", async (req) => {
    need(req.accountId, req.params.id);
    return { config: groups.welcome(req.accountId, req.params.id), log: groups.welcomeLog(req.accountId, req.params.id) };
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/groups/:id/welcome", async (req) => {
    need(req.accountId, req.params.id);
    return { config: groups.setWelcome(req.accountId, req.params.id, req.body) };
  });

  app.post<{ Params: { id: string }; Body: { kind?: string; config?: unknown } }>("/api/groups/:id/welcome/preview", async (req) => {
    need(req.accountId, req.params.id);
    const kind = req.body?.kind === "private" ? "private" : "group";
    return { texts: groups.preview(req.accountId, req.params.id, kind, req.body?.config) };
  });
}
