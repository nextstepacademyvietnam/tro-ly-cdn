import type { AssistantStore, Draft } from "../core/assistantStore.js";
import { type Profile, type ProfileStore, resolveProfile } from "../core/profiles.js";
import { vnTodayLabel } from "../core/promptLayers.js";
import { MARK_SILENT } from "../core/replyPolicy.js";
import type { ReplierAccount } from "../core/replier.js";
import type { Engine } from "../engines/types.js";
import {
  DAY_MS,
  addDays,
  analysisSystemPrompt,
  analysisUserPrompt,
  careMessageSystemPrompt,
  careMessageUserPrompt,
  inQuietVN,
  parseCarePlan,
  slotOnDay,
  transcript,
  vnDay,
} from "./prompt.js";
import { type CarePlan, type CareStore, snapshot } from "./store.js";

/** Hội thoại yên ngần này sau tin cuối mới phân tích (đợi khách nói xong). */
export const ANALYZE_AFTER_QUIET_MS = 30 * 60_000;
/** Chỉ lập kế hoạch cho khách có nhắn trong ngần này ngày. */
export const ANALYZE_LOOKBACK_MS = 90 * DAY_MS;
/** Khách / chủ vừa nhắn trong ngần này thì chưa chủ động nhắn (dời sang hôm sau). */
export const RECENT_CHAT_MS = 12 * 3_600_000;
const TICK_MS = 30_000;
const ANALYZE_MESSAGES = 60;
const CARE_MESSAGES = 20;

export interface CareDeps {
  store: CareStore;
  assistant: AssistantStore;
  profiles: ProfileStore;
  account(id: number): ReplierAccount | undefined;
  accountIds(): number[];
  engine(): Engine | null;
  now?: () => number;
  rand?: () => number;
  log?: (msg: string, extra?: object) => void;
}

export type CareSkip = { act: "skip"; reason: string; nextAt: number | null; stop?: boolean; pause?: boolean };

/**
 * Chăm sóc khách chủ động:
 * - Phân tích: hội thoại chat riêng có nhãn tính cách bật chăm sóc, yên 30 phút sau tin cuối và có tin mới kể từ lần
 *   phân tích trước → AI cập nhật hồ sơ, tóm tắt, nhu cầu, giai đoạn, tần suất, ngày chăm sóc tới.
 * - Chạy lịch: tới ngày thì AI soạn tin chăm sóc thành NHÁP CHỜ DUYỆT (không tự gửi), rồi đẩy lịch thêm một chu kỳ.
 * - Mỗi lượt chỉ một việc gọi AI để không ngốn hạn mức gói AI của khách.
 */
export class CareService {
  private readonly now: () => number;
  private readonly rand: () => number;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(private readonly d: CareDeps) {
    this.now = d.now ?? Date.now;
    this.rand = d.rand ?? Math.random;
  }

  /** Tính cách đang lo hội thoại này, nếu nó bật chăm sóc và áp dụng cho chat riêng. */
  careProfile(accountId: number, threadId: string, labels: unknown[] | null): Profile | null {
    const acc = this.d.account(accountId);
    const conv = acc?.inbox.conversation(threadId);
    if (!acc || !conv || conv.thread_type !== "user") return null;
    const r = resolveProfile(conv, this.d.profiles.list(accountId), labels, this.d.profiles.offTag(accountId));
    if (r.kind !== "profile" || !r.profile.care.enabled) return null;
    return r.profile;
  }

  // ---------- Phân tích ----------

  /** Phân tích một khách và lưu hồ sơ + kế hoạch. Trả null khi không áp dụng (không có tính cách bật chăm sóc…). */
  async analyze(accountId: number, threadId: string, labels?: unknown[] | null): Promise<CarePlan | null> {
    const acc = this.d.account(accountId);
    if (!acc) return null;
    const conv = acc.inbox.conversation(threadId);
    if (!conv) return null;
    const lb = labels === undefined ? await acc.labels() : labels;
    const profile = this.careProfile(accountId, threadId, lb);
    if (!profile) return null;
    const engine = this.d.engine();
    if (!engine) throw new Error("Chưa chọn mô hình AI");
    const now = this.now();
    const msgs = acc.inbox.messages(threadId, ANALYZE_MESSAGES);
    if (!msgs.length) return null;
    const cur = this.d.store.get(accountId, threadId);
    const ownerName = acc.ownerName();
    const raw = await engine.generate({
      system: analysisSystemPrompt({ persona: this.d.profiles.compose(profile.id, undefined, now), rules: profile.care.rules, ownerName, profileName: profile.name }),
      messages: [
        {
          role: "user",
          content: analysisUserPrompt({
            today: vnTodayLabel(now),
            customerName: conv.name,
            salutation: acc.salutation(threadId),
            plan: cur ? snapshot(cur) : null,
            transcript: transcript(msgs, conv.name),
          }),
        },
      ],
    });
    const today = vnDay(now);
    const u = parseCarePlan(raw, today);
    if (!u.summary && !u.facts && !u.stop && u.everyDays === null) {
      this.d.store.log(accountId, threadId, "error", "AI không trả về hồ sơ đúng mẫu", now);
      throw new Error("AI không trả về hồ sơ đúng mẫu");
    }
    const plan = this.d.store.applyAnalysis(accountId, threadId, profile.id, u, this.planNext(u.nextDay, u.everyDays ?? cur?.everyDays ?? 3, now), now);
    // Khách đã nói chuyện tiếp sau khi nháp chăm sóc được soạn: nháp đó lỗi thời.
    this.d.assistant.supersedeOrigin(accountId, threadId, "care", conv.last_message_at, now);
    this.d.store.log(
      accountId,
      threadId,
      plan.status === "stopped" && u.stop ? "stop" : "analyze",
      u.stop && plan.status === "stopped"
        ? `AI đề nghị dừng chăm sóc: ${u.stop}`
        : `${plan.stage || "Chưa rõ giai đoạn"} · mỗi ${plan.everyDays} ngày${plan.nextAt ? ` · lần tới ${vnDay(plan.nextAt).split("-").reverse().join("/")}` : ""}${plan.reason ? ` — ${plan.reason}` : ""}`,
      now,
    );
    return plan;
  }

  /** Giờ chăm sóc kế tiếp: ngày AI chọn (hoặc hôm nay + N ngày), lúc ngẫu nhiên 08:30–11:00. */
  private planNext(nextDay: string | null, everyDays: number, now: number): number {
    const today = vnDay(now);
    const day = nextDay ?? addDays(today, everyDays);
    const at = slotOnDay(day, this.rand);
    if (at > now) return at;
    // Hẹn hôm nay mà đã qua khung sáng: soạn trong 15 phút nếu chưa tới giờ yên lặng, không thì sáng mai.
    return inQuietVN(now + 15 * 60_000) ? slotOnDay(addDays(today, 1), this.rand) : now + 15 * 60_000;
  }

  /** Hội thoại cần phân tích: có tin mới sau lần phân tích trước, đã yên 30 phút. Một hội thoại / lượt. */
  async findOneToAnalyze(accountId: number): Promise<string | null> {
    const acc = this.d.account(accountId);
    if (!acc?.isConnected()) return null; // không đọc được nhãn Zalo thì chưa biết ai thuộc tính cách nào
    const profiles = this.d.profiles.list(accountId).filter((p) => p.care.enabled);
    if (!profiles.length) return null;
    const labels = await acc.labels();
    if (!labels) return null;
    const now = this.now();
    const analyzed = this.d.store.analyzedTimes(accountId);
    for (const c of acc.inbox.conversations()) {
      if (c.thread_type !== "user" || !c.last_message_at) continue;
      if (now - c.last_message_at < ANALYZE_AFTER_QUIET_MS || now - c.last_message_at > ANALYZE_LOOKBACK_MS) continue;
      if (c.last_message_at <= (analyzed.get(c.thread_id) ?? 0)) continue;
      const plan = this.d.store.get(accountId, c.thread_id);
      if (plan && plan.status !== "active") continue;
      if (this.careProfile(accountId, c.thread_id, labels)) return c.thread_id;
    }
    return null;
  }

  // ---------- Chạy lịch ----------

  /** Quyết định với một kế hoạch tới hạn (hàm gần như thuần, test được). */
  check(plan: CarePlan, labels: unknown[] | null): { act: "draft"; profile: Profile } | CareSkip {
    const now = this.now();
    const today = vnDay(now);
    const tomorrow = slotOnDay(addDays(today, 1), this.rand);
    const acc = this.d.account(plan.accountId);
    const conv = acc?.inbox.conversation(plan.threadId);
    if (!acc || !conv) return { act: "skip", reason: "Không còn hội thoại này", nextAt: null, stop: true };
    if (conv.no_proactive) return { act: "skip", reason: "Khách xin không nhận tin chủ động", nextAt: null, stop: true };
    if (this.d.assistant.isPaused(plan.accountId)) return { act: "skip", reason: "Trợ lý đang tạm dừng", nextAt: tomorrow };
    if (!acc.isConnected() || !labels) return { act: "skip", reason: "Zalo chưa kết nối", nextAt: now + 3_600_000 };
    const profile = this.careProfile(plan.accountId, plan.threadId, labels);
    if (!profile) return { act: "skip", reason: "Khách không còn gắn nhãn tính cách bật chăm sóc", nextAt: null, pause: true };
    if (conv.handoff_until > now) return { act: "skip", reason: "Khách đang chờ người thật", nextAt: Math.max(tomorrow, slotOnDay(addDays(vnDay(conv.handoff_until), 1), this.rand)) };
    if (now - conv.last_message_at < RECENT_CHAT_MS) return { act: "skip", reason: "Vừa nói chuyện với khách, để hôm sau", nextAt: tomorrow };
    if (this.d.assistant.pending(plan.accountId, plan.threadId).some((d) => d.origin === "care"))
      return { act: "skip", reason: "Tin chăm sóc trước còn chờ duyệt", nextAt: tomorrow };
    if (this.d.store.draftedToday(plan.accountId, profile.id, now) >= profile.care.maxPerDay)
      return { act: "skip", reason: `Đủ ${profile.care.maxPerDay} tin chăm sóc hôm nay`, nextAt: tomorrow };
    if (inQuietVN(now)) return { act: "skip", reason: "Giờ yên lặng", nextAt: now < slotOnDay(today, () => 0) ? slotOnDay(today, this.rand) : tomorrow };
    return { act: "draft", profile };
  }

  /** Soạn tin chăm sóc cho một kế hoạch tới hạn → nháp chờ duyệt. */
  async runPlan(plan: CarePlan, labels: unknown[] | null): Promise<"draft" | "skip"> {
    const now = this.now();
    const c = this.check(plan, labels);
    if (c.act === "skip") {
      if (c.stop) this.d.store.edit(plan.accountId, plan.threadId, { status: "stopped", nextAt: null }, now);
      else if (c.pause) this.d.store.edit(plan.accountId, plan.threadId, { status: "paused" }, now);
      else if (c.nextAt) this.d.store.reschedule(plan.accountId, plan.threadId, c.nextAt, now);
      this.d.store.log(plan.accountId, plan.threadId, c.stop ? "stop" : "skip", c.reason, now);
      return "skip";
    }
    const acc = this.d.account(plan.accountId)!;
    const conv = acc.inbox.conversation(plan.threadId)!;
    const engine = this.d.engine();
    if (!engine) {
      this.d.store.reschedule(plan.accountId, plan.threadId, now + 3_600_000, now);
      this.d.store.log(plan.accountId, plan.threadId, "error", "Chưa chọn mô hình AI", now);
      return "skip";
    }
    const salutation = acc.salutation(plan.threadId);
    const raw = await engine.generate({
      system: careMessageSystemPrompt({
        persona: this.d.profiles.compose(c.profile.id, undefined, now),
        rules: c.profile.care.rules,
        ownerName: acc.ownerName(),
        profileName: c.profile.name,
        salutation,
      }),
      messages: [
        {
          role: "user",
          content: careMessageUserPrompt({
            today: vnTodayLabel(now),
            customerName: conv.name,
            plan: snapshot(plan),
            transcript: transcript(acc.inbox.messages(plan.threadId, CARE_MESSAGES), conv.name),
          }),
        },
      ],
    });
    const next = slotOnDay(addDays(vnDay(now), plan.everyDays), this.rand);
    const text = raw.trim().replace(/^["“”']+|["“”']+$/g, "").trim();
    if (!text || text.includes(MARK_SILENT)) {
      this.d.store.reschedule(plan.accountId, plan.threadId, next, now);
      this.d.store.log(plan.accountId, plan.threadId, "skip", "AI thấy chưa nên nhắn lúc này, dời một chu kỳ", now);
      return "skip";
    }
    this.d.assistant.addDraft(plan.accountId, plan.threadId, c.profile.id, text, false, now, "care");
    this.d.assistant.notify(plan.accountId, "care", `Tin chăm sóc cho ${conv.name || "khách"} đang chờ duyệt${plan.goal ? ` (${plan.goal})` : ""}.`, plan.threadId, now);
    this.d.store.reschedule(plan.accountId, plan.threadId, next, now);
    this.d.store.log(plan.accountId, plan.threadId, "draft", text, now);
    return "draft";
  }

  /** Nháp chăm sóc vừa được gửi: tính một lần chăm sóc. Replier gọi sau khi gửi xong. */
  onDraftSent(d: Draft) {
    if (d.origin !== "care") return;
    const now = this.now();
    this.d.store.markSent(d.accountId, d.threadId, now);
    this.d.store.log(d.accountId, d.threadId, "sent", d.text, now);
  }

  /** Một lượt: ưu tiên soạn tin tới hạn, không có thì phân tích một khách. Mỗi lượt tối đa một lần gọi AI. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const due = this.d.store.due(this.now(), 10);
      const labelCache = new Map<number, unknown[] | null>();
      const labelsOf = async (id: number) => {
        if (!labelCache.has(id)) labelCache.set(id, (await this.d.account(id)?.labels().catch(() => null)) ?? null);
        return labelCache.get(id)!;
      };
      for (const plan of due) {
        try {
          if ((await this.runPlan(plan, await labelsOf(plan.accountId))) === "draft") return;
        } catch (err) {
          const now = this.now();
          this.d.store.reschedule(plan.accountId, plan.threadId, now + 3_600_000, now);
          this.d.store.log(plan.accountId, plan.threadId, "error", `Không soạn được tin: ${(err as Error).message}`, now);
          this.d.log?.("Lỗi soạn tin chăm sóc", { thread: plan.threadId, err: (err as Error).message });
          return;
        }
      }
      for (const id of this.d.accountIds()) {
        const thread = await this.findOneToAnalyze(id).catch(() => null);
        if (!thread) continue;
        try {
          await this.analyze(id, thread, await labelsOf(id));
        } catch (err) {
          this.d.log?.("Lỗi phân tích khách", { thread, err: (err as Error).message });
        }
        return;
      }
    } finally {
      this.busy = false;
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
