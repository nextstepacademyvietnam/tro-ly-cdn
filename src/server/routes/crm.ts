import type { FastifyInstance } from "fastify";
import type { AccountManager } from "../../channels/zalo/accounts.js";
import type { CrmService } from "../../crm/service.js";
import type { ZaloMatcher } from "../../crm/zaloMatch.js";

/** Tra khách trong Pancake CRM từ Hộp thư (chỉ đọc CRM). */
export function registerCrmRoutes(
  app: FastifyInstance,
  d: { accounts: AccountManager; crm: () => CrmService | null; matcher?: () => ZaloMatcher | null; careNote?: (accountId: number, threadId: string) => string },
) {
  const fail = (err: unknown, code = 409) => Object.assign(new Error((err as Error).message), { statusCode: code });
  const state = (crm: CrmService) => ({ available: crm.available(), indexedAt: crm.indexedAt(), error: crm.lastError });
  const fmt = (ms: number) => new Date(ms + 7 * 3_600_000).toISOString().slice(0, 16).replace("T", " ").split(" ").map((x, i) => (i ? x : x.split("-").reverse().join("/"))).join(" ");
  /** Nội dung gợi sẵn khi lưu lead: tên, số, ghi chú (hồ sơ chăm sóc hoặc các tin khách vừa hỏi). */
  const leadDraft = (accountId: number, threadId: string, phones: { phone: string }[]) => {
    const svc = d.accounts.get(accountId);
    const conv = svc.inbox.conversation(threadId);
    const asked = svc.inbox
      .messages(threadId, 40)
      .filter((m) => m.direction === "in" && m.text)
      .slice(-4)
      .map((m) => `- ${m.text!.slice(0, 200)}`);
    const care = d.careNote?.(accountId, threadId) ?? "";
    const nick = d.accounts.row(accountId)?.name ?? "";
    const note = [`Từ Zalo${nick ? ` (nick ${nick})` : ""}, Trợ lý CDN lưu ngày ${fmt(Date.now()).split(" ")[0]}.`, care || (asked.length ? `Khách nhắn:\n${asked.join("\n")}` : "")]
      .filter(Boolean)
      .join("\n");
    return { name: svc.contacts.get(threadId)?.name || conv?.name || "", phone: phones[0]?.phone ?? "", note };
  };
  const view = (crm: CrmService, accountId: number, threadId: string) => {
    const svc = d.accounts.get(accountId);
    const r = crm.lookup(accountId, threadId, svc.inbox, svc.contacts.phone(threadId));
    return { ...state(crm), ...r, saved: crm.saved(accountId, threadId), leadDraft: leadDraft(accountId, threadId, r.phones) };
  };

  app.get<{ Params: { thread: string } }>("/api/crm/:thread", async (req) => {
    const crm = d.crm();
    if (!crm?.available()) return { available: false, phones: [], matches: [], indexedAt: 0, error: "" };
    const svc = d.accounts.get(req.accountId);
    const inbox = svc.inbox;
    if (!inbox.conversation(req.params.thread)) throw fail(new Error("Không có hội thoại này"), 404);
    // Hồ sơ Zalo có thể cho biết số điện thoại (bạn bè, hoặc người cho xem số).
    await svc.contacts.ensure([req.params.thread]).catch(() => undefined);
    return view(crm, req.accountId, req.params.thread);
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
    return view(crm, req.accountId, req.params.thread);
  });

  // ---------- Lưu lead vào CRM ----------
  app.get("/api/crm-tables", async () => {
    const crm = d.crm();
    if (!crm?.available()) throw fail(new Error("Chưa nối Pancake CRM"));
    try {
      const list = await crm.tables();
      return { tables: list.map((t) => ({ name: t.name, label: t.label })), defaultTable: crm.defaultTable(list) };
    } catch (err) {
      throw fail(err, 502);
    }
  });

  app.post<{ Params: { thread: string }; Body: { table?: string; name?: string; phone?: string; note?: string } }>("/api/crm/:thread/save", async (req) => {
    const crm = d.crm();
    if (!crm?.available()) throw fail(new Error("Chưa nối Pancake CRM"));
    if (!d.accounts.get(req.accountId).inbox.conversation(req.params.thread)) throw fail(new Error("Không có hội thoại này"), 404);
    try {
      const b = req.body ?? {};
      const r = await crm.saveLead(req.accountId, req.params.thread, { table: String(b.table ?? ""), name: String(b.name ?? ""), phone: String(b.phone ?? ""), note: String(b.note ?? "") });
      return { ...r, ...view(crm, req.accountId, req.params.thread) };
    } catch (err) {
      throw fail(err, 400);
    }
  });

  // Tiến độ nối CRM → Zalo theo số của nick đang chọn.
  app.get("/api/crm-zalo-progress", async (req) => {
    const m = d.matcher?.();
    if (!m || !d.crm()?.available()) return { available: false };
    return { available: true, ...m.progress(req.accountId) };
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
