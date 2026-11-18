import type { FastifyInstance } from "fastify";
import type { AccountManager } from "../../channels/zalo/accounts.js";
import type { AssistService } from "../../assist/service.js";
import type { AssistantStore } from "../../core/assistantStore.js";
import type { ProfileStore } from "../../core/profiles.js";
import type { Replier } from "../../core/replier.js";

const DAY = 24 * 3_600_000;

/** Khách chờ lâu (nhờ trợ lý soạn, không cần trả lời), gợi ý gắn nhãn, gợi ý hỏi đáp học từ chủ. */
export function registerAssistRoutes(
  app: FastifyInstance,
  d: { accounts: AccountManager; assist: AssistService; replier: Replier; profiles: ProfileStore; assistant: AssistantStore },
) {
  const fail = (err: unknown, code = 409) => Object.assign(new Error((err as Error).message), { statusCode: code });
  const inbox = (accountId: number, threadId: string) => {
    const box = d.accounts.get(accountId).inbox;
    if (!box.conversation(threadId)) throw fail(new Error("Không có hội thoại này"), 404);
    return box;
  };
  const ownProfile = (accountId: number, id: number) => {
    const p = d.profiles.get(id);
    if (!p || p.accountId !== accountId) throw fail(new Error("Không có tính cách này"), 404);
    return p;
  };

  // ---------- Khách chờ lâu ----------
  app.post<{ Params: { id: string } }>("/api/zalo/conversations/:id/no-reply", async (req) => {
    inbox(req.accountId, req.params.id).markNoReplyNeeded(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { profileId?: number } }>("/api/zalo/conversations/:id/ai-draft", async (req) => {
    inbox(req.accountId, req.params.id);
    const profileId = Number(req.body?.profileId);
    if (!Number.isInteger(profileId)) throw fail(new Error("Chọn tính cách để trợ lý soạn"), 400);
    try {
      return { draft: await d.replier.draftFor(req.accountId, req.params.id, profileId) };
    } catch (err) {
      throw fail(err);
    }
  });

  // ---------- Gợi ý gắn nhãn ----------
  app.post<{ Params: { id: string } }>("/api/zalo/conversations/:id/suggestion/dismiss", async (req) => {
    inbox(req.accountId, req.params.id);
    d.assist.dismissSuggestion(req.accountId, req.params.id);
    return { ok: true };
  });

  // ---------- Gợi ý hỏi đáp học từ cách chủ trả lời ----------
  const view = (accountId: number, profileId: number) => ({
    suggestions: d.assist.pendingSuggestions(profileId),
    learnedAt: d.assist.learnedAt(profileId),
    // Nháp trợ lý 30 ngày qua của cả tài khoản: gửi nguyên văn / bạn sửa / bỏ.
    drafts: d.assistant.draftStats(accountId, Date.now() - 30 * DAY),
  });

  app.get<{ Params: { id: string } }>("/api/profiles/:id/learn", async (req) => {
    const p = ownProfile(req.accountId, Number(req.params.id));
    return view(req.accountId, p.id);
  });

  app.post<{ Params: { id: string } }>("/api/profiles/:id/learn", async (req) => {
    const p = ownProfile(req.accountId, Number(req.params.id));
    let added: number;
    try {
      added = await d.assist.learn(p.id);
    } catch (err) {
      throw fail(err);
    }
    return { added, ...view(req.accountId, p.id) };
  });

  app.post<{ Params: { id: string; sid: string }; Body: { accept?: boolean; question?: string; answer?: string } }>(
    "/api/profiles/:id/learn/:sid",
    async (req) => {
      const p = ownProfile(req.accountId, Number(req.params.id));
      try {
        d.assist.decideSuggestion(p.id, Number(req.params.sid), Boolean(req.body?.accept), { question: req.body?.question, answer: req.body?.answer });
      } catch (err) {
        throw fail(err, 400);
      }
      return view(req.accountId, p.id);
    },
  );
}
