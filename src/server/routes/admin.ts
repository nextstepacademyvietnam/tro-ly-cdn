import type { FastifyInstance } from "fastify";
import type { AccountManager } from "../../channels/zalo/accounts.js";
import type { AdminStore } from "../../admin/commands.js";
import { DEFAULT_METRICS, METRICS, type Report, type Reports, describeSchedule } from "../../admin/reports.js";

/** Admin ra lệnh qua Zalo (danh sách người được ra lệnh) và báo cáo định kỳ cho admin. */
export function registerAdminRoutes(app: FastifyInstance, d: { accounts: AccountManager; admins: AdminStore; reports: Reports }) {
  const fail = (err: unknown, code = 400) => Object.assign(new Error((err as Error).message), { statusCode: code });
  const view = (accountId: number) => {
    const svc = d.accounts.get(accountId);
    return {
      admins: d.admins.list(accountId).map((a) => ({ ...a, name: a.name || svc.inbox.conversation(a.userId)?.name || "" })),
      reports: d.reports.list(accountId).map((r) => ({ ...r, schedule: describeSchedule(r) })),
      metrics: METRICS,
      defaultMetrics: DEFAULT_METRICS,
    };
  };

  app.get("/api/admin-zalo", async (req) => view(req.accountId));

  app.post<{ Body: { userId?: string } }>("/api/admin-zalo/admins", async (req) => {
    const svc = d.accounts.get(req.accountId);
    const id = String(req.body?.userId ?? "");
    const conv = svc.inbox.conversation(id);
    if (!conv || conv.thread_type !== "user") throw fail(new Error("Chọn một người trong Hộp thư (chat riêng)"));
    if (id === svc.channel.getStatus().ownId) throw fail(new Error("Chính nick này đã luôn là admin (nhắn trong Cloud của tôi)"));
    d.admins.add(req.accountId, id, conv.name);
    return view(req.accountId);
  });

  app.delete<{ Params: { userId: string } }>("/api/admin-zalo/admins/:userId", async (req) => {
    d.admins.remove(req.accountId, req.params.userId);
    return view(req.accountId);
  });

  app.post<{ Body: Partial<Report> }>("/api/admin-zalo/reports", async (req) => {
    try {
      d.reports.save(req.accountId, req.body ?? {});
    } catch (err) {
      throw fail(err);
    }
    return view(req.accountId);
  });

  app.put<{ Params: { id: string }; Body: Partial<Report> }>("/api/admin-zalo/reports/:id", async (req) => {
    try {
      d.reports.save(req.accountId, req.body ?? {}, Number(req.params.id));
    } catch (err) {
      throw fail(err);
    }
    return view(req.accountId);
  });

  app.delete<{ Params: { id: string } }>("/api/admin-zalo/reports/:id", async (req) => {
    d.reports.remove(req.accountId, Number(req.params.id));
    return view(req.accountId);
  });

  // Gửi thử ngay cho người nhận, hoặc chỉ xem trước nội dung.
  app.post<{ Params: { id: string }; Body: { preview?: boolean } }>("/api/admin-zalo/reports/:id/send", async (req) => {
    const r = d.reports.get(req.accountId, Number(req.params.id));
    if (!r) throw fail(new Error("Không có báo cáo này"), 404);
    if (req.body?.preview) return { text: d.reports.build(req.accountId, r.metrics, r.frequency, r.name) };
    try {
      return { sent: await d.reports.send(r) };
    } catch (err) {
      throw fail(err, 409);
    }
  });
}
