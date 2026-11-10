import type { FastifyInstance } from "fastify";
import type { AccountManager } from "../../channels/zalo/accounts.js";
import type { AssistantStore } from "../../core/assistantStore.js";
import type { Replier } from "../../core/replier.js";

/** Nháp chờ duyệt, thông báo cho chủ, tạm dừng / mở lại trợ lý. */
export function registerAssistantRoutes(app: FastifyInstance, accounts: AccountManager, store: AssistantStore, replier: Replier) {
  const fail = (err: unknown, code = 409) => Object.assign(new Error((err as Error).message), { statusCode: code });

  // ---------- Nháp ----------
  app.get<{ Querystring: { thread?: string } }>("/api/drafts", async (req) => ({
    drafts: store.pending(req.accountId, req.query.thread || undefined),
  }));

  const ownDraft = (accountId: number, id: number) => {
    const d = store.draft(id);
    if (!d || d.accountId !== accountId) throw fail(new Error("Không có nháp này"), 404);
    return d;
  };

  app.post<{ Params: { id: string }; Body: { text?: string } }>("/api/drafts/:id/send", async (req) => {
    ownDraft(req.accountId, Number(req.params.id));
    try {
      await replier.sendDraft(Number(req.params.id), req.body?.text);
    } catch (err) {
      throw fail(err);
    }
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/drafts/:id/discard", async (req) => {
    const d = ownDraft(req.accountId, Number(req.params.id));
    if (d.status === "pending") store.decide(d.id, "discarded");
    return { ok: true };
  });

  // ---------- Thông báo ----------
  app.get("/api/notifications", async (req) => ({
    unread: store.unreadCount(req.accountId),
    notifications: store.notices(req.accountId),
  }));
  app.post("/api/notifications/read-all", async (req) => {
    store.markAllRead(req.accountId);
    return { ok: true };
  });

  // ---------- Tạm dừng toàn bộ ----------
  app.get("/api/assistant", async (req) => ({ paused: store.isPaused(req.accountId) }));
  app.put<{ Body: { paused?: boolean } }>("/api/assistant", async (req) => {
    store.setPaused(req.accountId, Boolean(req.body?.paused));
    return { paused: store.isPaused(req.accountId) };
  });

  // ---------- Mở lại hội thoại đang chờ người thật ----------
  app.post<{ Params: { id: string } }>("/api/zalo/conversations/:id/resume", async (req) => {
    accounts.get(req.accountId).inbox.clearHandoff(req.params.id);
    return { ok: true };
  });
}
