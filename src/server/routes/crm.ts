import type { FastifyInstance } from "fastify";
import type { AccountManager } from "../../channels/zalo/accounts.js";
import type { CrmService } from "../../crm/service.js";

/** Tra khách trong Pancake CRM từ Hộp thư (chỉ đọc CRM). */
export function registerCrmRoutes(app: FastifyInstance, d: { accounts: AccountManager; crm: () => CrmService | null }) {
  const fail = (err: unknown, code = 409) => Object.assign(new Error((err as Error).message), { statusCode: code });
  const state = (crm: CrmService) => ({ available: crm.available(), indexedAt: crm.indexedAt(), error: crm.lastError });

  app.get<{ Params: { thread: string } }>("/api/crm/:thread", async (req) => {
    const crm = d.crm();
    if (!crm?.available()) return { available: false, phones: [], matches: [], indexedAt: 0, error: "" };
    const svc = d.accounts.get(req.accountId);
    const inbox = svc.inbox;
    if (!inbox.conversation(req.params.thread)) throw fail(new Error("Không có hội thoại này"), 404);
    // Hồ sơ Zalo có thể cho biết số điện thoại (bạn bè, hoặc người cho xem số).
    await svc.contacts.ensure([req.params.thread]).catch(() => undefined);
    return { ...state(crm), ...crm.lookup(req.accountId, req.params.thread, inbox, svc.contacts.phone(req.params.thread)) };
  });

  app.put<{ Params: { thread: string }; Body: { phone?: string } }>("/api/crm/:thread", async (req) => {
    const crm = d.crm();
    if (!crm) throw fail(new Error("Chưa nối Pancake CRM"));
    const svc = d.accounts.get(req.accountId);
    const inbox = svc.inbox;
    if (!inbox.conversation(req.params.thread)) throw fail(new Error("Không có hội thoại này"), 404);
    try {
      crm.link(req.accountId, req.params.thread, String(req.body?.phone ?? ""));
    } catch (err) {
      throw fail(err, 400);
    }
    return { ...state(crm), ...crm.lookup(req.accountId, req.params.thread, inbox, svc.contacts.phone(req.params.thread)) };
  });

  app.post("/api/crm/refresh", async () => {
    const crm = d.crm();
    if (!crm?.available()) throw fail(new Error("Chưa nối Pancake CRM"));
    try {
      const records = await crm.refresh();
      return { records, ...state(crm) };
    } catch (err) {
      throw fail(err, 502);
    }
  });
}
