import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AccountManager } from "../../channels/zalo/accounts.js";
import { type ProfileStore, resolveProfile } from "../../core/profiles.js";
import type { AssistantStore } from "../../core/assistantStore.js";
import type { ScheduleStore } from "../../scheduler/store.js";

declare module "fastify" {
  interface FastifyRequest {
    accountId: number;
  }
}

export function registerAccountRoutes(app: FastifyInstance, accounts: AccountManager, profiles: ProfileStore, assistant: AssistantStore, schedules?: ScheduleStore) {
  const fail = (err: unknown, code = 409) => Object.assign(new Error((err as Error).message), { statusCode: code });
  const svc = (req: FastifyRequest) => {
    try {
      return accounts.get(req.accountId);
    } catch (err) {
      throw fail(err, 404);
    }
  };

  // Tài khoản đang thao tác: header x-cdn-account, mặc định tài khoản đầu tiên.
  app.decorateRequest("accountId", 0);
  app.addHook("preHandler", async (req) => {
    const raw = Number(req.headers["x-cdn-account"] ?? (req.query as { account?: string } | undefined)?.account);
    req.accountId = Number.isInteger(raw) && raw > 0 && accounts.row(raw) ? raw : accounts.firstId();
  });

  // ---------- Tài khoản ----------
  app.get("/api/accounts", async () => ({
    accounts: accounts.list().map((a) => {
      const s = accounts.get(a.id);
      const st = s.channel.getStatus();
      const counts = s.inbox.counts();
      const draftThreads = new Set(assistant.pendingCounts(a.id).keys());
      return {
        id: a.id,
        name: a.name,
        offTag: a.off_tag,
        state: st.state,
        ownName: st.ownName ?? "",
        paused: assistant.isPaused(a.id),
        unread: assistant.unreadCount(a.id),
        pendingDrafts: assistant.pending(a.id).length,
        // "Cần xử lý" = hội thoại có nháp chờ duyệt hoặc đang chờ người thật.
        needsAction: new Set([...draftThreads, ...counts.waitingThreads]).size,
        unreadConversations: counts.unread,
        activeSchedules: schedules ? schedules.list({ accountId: a.id, status: "active" }).length : 0,
        trackedGroups: accounts.trackedGroupCount(a.id),
      };
    }),
  }));

  app.post<{ Body: { name?: string } }>("/api/accounts", async (req) => ({ account: accounts.create(req.body?.name ?? "") }));

  app.put<{ Params: { id: string }; Body: { name?: string; offTag?: string } }>("/api/accounts/:id", async (req) => {
    const id = Number(req.params.id);
    if (!accounts.row(id)) throw fail(new Error("Không có tài khoản này"), 404);
    try {
      if (req.body?.name !== undefined) accounts.rename(id, req.body.name);
      if (req.body?.offTag !== undefined) accounts.setOffTag(id, req.body.offTag);
    } catch (err) {
      throw fail(err, 400);
    }
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/accounts/:id", async (req) => {
    try {
      await accounts.remove(Number(req.params.id));
    } catch (err) {
      throw fail(err, 400);
    }
    return { ok: true };
  });

  // ---------- Kết nối Zalo của tài khoản đang chọn ----------
  app.get("/api/zalo/status", async (req) => {
    const s = svc(req);
    return { ...s.channel.getStatus(), hasSession: s.channel.hasCredentials() };
  });

  app.post("/api/zalo/login", async (req) => {
    try {
      await svc(req).channel.loginWithQr();
    } catch (err) {
      throw fail(err);
    }
    return { ok: true };
  });

  app.post("/api/zalo/reconnect", async (req) => {
    try {
      await svc(req).channel.connect();
    } catch (err) {
      throw fail(err);
    }
    return { ok: true };
  });

  app.post("/api/zalo/logout", async (req) => {
    await svc(req).channel.logout();
    return { ok: true };
  });

  app.get("/api/zalo/groups", async (req) => {
    try {
      return { groups: await svc(req).channel.groups() };
    } catch (err) {
      throw fail(err);
    }
  });

  app.get("/api/zalo/labels", async (req) => {
    const info = await svc(req).channel.labelInfo();
    return { connected: info !== null, labels: (info ?? []).map((l) => l.name), details: info ?? [] };
  });

  // ---------- Hộp thư ----------
  app.get("/api/zalo/conversations", async (req) => {
    const s = svc(req);
    const list = profiles.list(req.accountId);
    const labels = await s.channel.labels();
    const offTag = profiles.offTag(req.accountId);
    const pending = assistant.pendingCounts(req.accountId);
    const since = assistant.pendingSince(req.accountId);
    const first = s.inbox.firstMessageTimes();
    const now = Date.now();
    return {
      labelsAvailable: labels !== null,
      conversations: s.inbox.conversations().map((c) => {
        const r = resolveProfile(c, list, labels, offTag);
        return {
          ...c,
          pendingDrafts: pending.get(c.thread_id) ?? 0,
          draftSince: since.get(c.thread_id) ?? 0,
          firstMessageAt: first.get(c.thread_id) ?? 0,
          waitingHuman: c.handoff_until > now,
          bot:
            r.kind === "profile"
              ? { kind: "profile", profileId: r.profile.id, name: r.profile.name, source: r.source, conflict: r.conflict.map((p) => p.name) }
              : r.kind === "off"
                ? { kind: "off", source: r.source }
                : { kind: "none" },
        };
      }),
    };
  });

  app.get<{ Params: { id: string } }>("/api/zalo/conversations/:id/messages", async (req, reply) => {
    const s = svc(req);
    const conv = s.inbox.conversation(req.params.id);
    if (!conv) return reply.code(404).send({ error: "Không có hội thoại này" });
    s.inbox.markRead(req.params.id);
    return { conversation: conv, messages: s.inbox.messages(req.params.id) };
  });

  app.post<{ Params: { id: string }; Body: { text?: string } }>("/api/zalo/conversations/:id/send", async (req, reply) => {
    const s = svc(req);
    const text = (req.body?.text ?? "").trim();
    if (!text) return reply.code(400).send({ error: "Tin nhắn trống" });
    if (text.length > 6000) return reply.code(400).send({ error: "Tin nhắn quá dài" });
    if (!s.inbox.conversation(req.params.id)) return reply.code(404).send({ error: "Không có hội thoại này" });
    try {
      await s.sendFromOwner(req.params.id, text);
    } catch (err) {
      throw fail(err);
    }
    return { ok: true };
  });

  /**
   * Gắn tính cách hàng loạt = gắn NHÃN THẬT trong Zalo (thấy được và sửa được trên điện thoại).
   * value: id tính cách (gắn nhãn của nó) | "off" (gắn nhãn tắt bot) | null (gỡ mọi nhãn trợ lý).
   */
  app.post<{ Body: { threadIds?: string[]; value?: number | "off" | null } }>("/api/zalo/conversations/assign", async (req, reply) => {
    const s = svc(req);
    const ids = (req.body?.threadIds ?? []).map(String).filter(Boolean);
    const value = req.body?.value ?? null;
    if (!ids.length) return reply.code(400).send({ error: "Chưa chọn hội thoại nào" });
    const list = profiles.list(req.accountId);
    const offTag = profiles.offTag(req.accountId);
    let target: string | null = null;
    if (typeof value === "number") {
      const p = list.find((x) => x.id === value);
      if (!p) return reply.code(400).send({ error: "Tính cách không thuộc tài khoản này" });
      if (!p.tag) return reply.code(400).send({ error: `Tính cách "${p.name}" chưa đặt nhãn Zalo — vào trang Tính cách chọn nhãn trước` });
      target = p.tag;
    } else if (value === "off") {
      target = offTag;
    } else if (value !== null) {
      return reply.code(400).send({ error: "Giá trị không hợp lệ" });
    }
    if (!s.channel.isConnected()) return reply.code(409).send({ error: "Zalo chưa kết nối nên chưa ghi được nhãn" });
    const exclusive = [...list.map((p) => p.tag).filter(Boolean), offTag];
    const failed: string[] = [];
    const created = new Set<string>();
    for (const id of ids) {
      const conv = s.inbox.conversation(id);
      if (!conv) continue;
      try {
        const r = await s.channel.setLabel(id, conv.thread_type, target, exclusive);
        if (r.created) created.add(r.created);
        s.inbox.assign([id], null); // bỏ kiểu gắn riêng trong app (bản cũ): Zalo là nguồn duy nhất
      } catch (err) {
        failed.push(`${conv.name || id}: ${(err as Error).message}`);
      }
    }
    if (failed.length === ids.length) return reply.code(409).send({ error: failed.join("; ") });
    return { ok: true, count: ids.length - failed.length, failed, created: [...created] };
  });
}
