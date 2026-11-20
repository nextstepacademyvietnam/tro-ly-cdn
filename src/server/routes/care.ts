import type { FastifyInstance } from "fastify";
import type { AccountManager } from "../../channels/zalo/accounts.js";
import type { ProfileStore } from "../../core/profiles.js";
import type { CareService } from "../../care/service.js";
import type { CarePlan, CareStatus, CareStore } from "../../care/store.js";
import { vnAt } from "../../care/prompt.js";

/** Chăm sóc khách chủ động: danh sách kế hoạch, hồ sơ từng khách, sửa lịch, phân tích lại, cài đặt theo tính cách. */
export function registerCareRoutes(app: FastifyInstance, deps: { store: CareStore; service: CareService; accounts: AccountManager; profiles: ProfileStore }) {
  const { store, service, accounts, profiles } = deps;
  const fail = (err: unknown, code = 409) => Object.assign(new Error((err as Error).message), { statusCode: code });

  const view = (accountId: number, p: CarePlan) => {
    const conv = accounts.replierAccount(accountId)?.inbox.conversation(p.threadId);
    return { ...p, name: conv?.name ?? "", lastMessageAt: conv?.last_message_at ?? 0, profileName: p.profileId ? (profiles.get(p.profileId)?.name ?? "") : "" };
  };

  app.get("/api/care", async (req) => ({
    plans: store.list(req.accountId).map((p) => view(req.accountId, p)),
    dueToday: store.dueToday(req.accountId, Date.now()),
  }));

  app.get<{ Params: { thread: string } }>("/api/care/:thread", async (req) => {
    const acc = accounts.replierAccount(req.accountId);
    const conv = acc?.inbox.conversation(req.params.thread);
    if (!conv) throw fail(new Error("Không có hội thoại này"), 404);
    const plan = store.get(req.accountId, req.params.thread);
    const labels = acc?.isConnected() ? await acc.labels().catch(() => null) : null;
    const profile = conv.thread_type === "user" ? service.careProfile(req.accountId, req.params.thread, labels) : null;
    return {
      plan: plan ? view(req.accountId, plan) : null,
      history: store.history(req.accountId, req.params.thread, 20),
      /** Tính cách bật chăm sóc đang lo hội thoại này (null = không áp dụng / chưa đọc được nhãn). */
      careProfile: profile ? { id: profile.id, name: profile.name } : null,
      labelsKnown: labels !== null,
    };
  });

  app.put<{
    Params: { thread: string };
    Body: { facts?: string; summary?: string; needs?: string; goal?: string; stage?: string; everyDays?: number; nextDay?: string; locked?: boolean; status?: CareStatus };
  }>("/api/care/:thread", async (req) => {
    const b = req.body ?? {};
    const patch: Parameters<CareStore["edit"]>[2] = {};
    for (const k of ["facts", "summary", "needs", "goal", "stage"] as const) if (typeof b[k] === "string") patch[k] = b[k]!.trim().slice(0, 4000);
    if (b.everyDays !== undefined) patch.everyDays = Number(b.everyDays);
    if (b.locked !== undefined) patch.locked = Boolean(b.locked);
    if (b.status !== undefined) {
      if (!["active", "paused", "stopped"].includes(b.status)) throw fail(new Error("Trạng thái không hợp lệ"), 400);
      patch.status = b.status;
    }
    if (b.nextDay !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.nextDay)) throw fail(new Error("Ngày không hợp lệ"), 400);
      patch.nextAt = vnAt(b.nextDay, 9 * 60); // 09:00 giờ VN của ngày chủ chọn
    }
    // Bật lại kế hoạch đã dừng mà chưa có ngày: hẹn sáng mai.
    const cur = store.get(req.accountId, req.params.thread);
    if (patch.status === "active" && !patch.nextAt && cur && !cur.nextAt) patch.nextAt = Date.now() + 86_400_000;
    try {
      const plan = store.edit(req.accountId, req.params.thread, patch, Date.now());
      store.log(req.accountId, req.params.thread, "edit", describeEdit(b), Date.now());
      return { plan: view(req.accountId, plan) };
    } catch (err) {
      throw fail(err, 404);
    }
  });

  app.post<{ Params: { thread: string } }>("/api/care/:thread/analyze", async (req) => {
    try {
      const plan = await service.analyze(req.accountId, req.params.thread);
      if (!plan) throw new Error("Khách này không gắn nhãn của tính cách nào bật chăm sóc chủ động (hoặc chưa có tin nhắn).");
      return { plan: view(req.accountId, plan), history: store.history(req.accountId, req.params.thread, 20) };
    } catch (err) {
      throw fail(err);
    }
  });

  // ---------- Cài đặt chăm sóc của tính cách ----------
  app.put<{ Params: { id: string }; Body: { enabled?: boolean; rules?: string; maxPerDay?: number } }>("/api/profiles/:id/care", async (req) => {
    const p = profiles.get(Number(req.params.id));
    if (!p || p.accountId !== req.accountId) throw fail(new Error("Không có tính cách này"), 404);
    return { care: profiles.setCare(p.id, req.body ?? {}) };
  });
}

function describeEdit(b: Record<string, unknown>): string {
  const parts: string[] = [];
  if (b.status === "paused") parts.push("Tạm dừng chăm sóc");
  if (b.status === "active") parts.push("Bật lại chăm sóc");
  if (b.status === "stopped") parts.push("Dừng chăm sóc");
  if (b.everyDays !== undefined) parts.push(`mỗi ${b.everyDays} ngày`);
  if (typeof b.nextDay === "string") parts.push(`lần tới ${b.nextDay.split("-").reverse().join("/")}`);
  if (b.locked === true) parts.push("khoá lịch");
  if (b.locked === false) parts.push("mở khoá lịch");
  if (["facts", "summary", "needs", "goal", "stage"].some((k) => typeof b[k] === "string")) parts.push("sửa hồ sơ");
  return `Chủ ${parts.join(", ") || "sửa kế hoạch"}`;
}
