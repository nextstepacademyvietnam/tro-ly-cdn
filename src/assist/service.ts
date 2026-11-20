import type { MessageRow } from "../channels/zalo/inbox.js";
import type { AssistantStore } from "../core/assistantStore.js";
import { type Profile, type ProfileStore, resolveProfile } from "../core/profiles.js";
import type { ReplierAccount } from "../core/replier.js";
import type { DB } from "../server/db.js";
import type { Engine } from "../engines/types.js";
import {
  type LearnPair,
  learnSystemPrompt,
  learnUserPrompt,
  parseLearned,
  parseTriage,
  triageSystemPrompt,
  triageUserPrompt,
} from "./prompt.js";

const DAY = 24 * 3_600_000;
/** Chờ khách nhắn xong ngần này rồi mới xét gợi ý nhãn. */
export const TRIAGE_QUIET_MS = 2 * 60_000;
/** Chỉ xét khách có nhắn trong ngần này. */
export const TRIAGE_LOOKBACK_MS = 7 * DAY;
/** Học từ các lượt chủ trả lời trong ngần này. */
export const LEARN_LOOKBACK_MS = 30 * DAY;
/** Tự tìm gợi ý hỏi đáp mỗi ngày một lần khi có ít nhất ngần này lượt chủ trả lời mới. */
export const LEARN_AUTO_MIN_PAIRS = 5;
const TICK_MS = 60_000;
const MAX_PAIRS = 40;
/** Câu chủ trả lời ngắn hơn ngần này ký tự ("ok", "dạ") không có gì để học. */
const MIN_ANSWER = 20;

export interface FaqSuggestion {
  id: number;
  profileId: number;
  question: string;
  answer: string;
  evidence: string;
  createdAt: number;
}

export interface AssistDeps {
  db: DB;
  assistant: AssistantStore;
  profiles: ProfileStore;
  account(id: number): ReplierAccount | undefined;
  accountIds(): number[];
  /** Chat với admin không phải khách: không gợi ý nhãn, không học hỏi đáp. */
  isAdmin?(accountId: number, userId: string): boolean;
  engine(): Engine | null;
  now?: () => number;
  log?: (msg: string, extra?: object) => void;
}

/** Tính cách có thể gợi ý cho khách chat riêng: có nhãn Zalo, áp dụng cho chat riêng. */
const forPrivate = (list: Profile[]) => list.filter((p) => p.tag && p.applies !== "group");

/**
 * Hai việc nền giúp trợ lý thành "nhân viên thật", mỗi lượt tối đa một lần gọi AI:
 * - Gợi ý gắn nhãn: khách mới nhắn riêng chưa có nhãn trợ lý → AI đoán tính cách hợp (hoặc "không": người nhà, nội bộ…).
 *   Chỉ gợi ý, chủ bấm mới gắn.
 * - Học từ chủ: các lượt chủ tự trả lời khách / sửa nháp trợ lý → AI rút thành gợi ý hỏi đáp, chủ duyệt mới vào tầng 2.
 */
export class AssistService {
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(private readonly d: AssistDeps) {
    this.now = d.now ?? Date.now;
  }

  // ---------- Gợi ý gắn nhãn ----------

  /** Hội thoại cần xét gợi ý nhãn (chưa xét, hoặc xét ra "không" mà khách nhắn lại sau một ngày). */
  triageCandidates(accountId: number, labels: unknown[], limit = 5): string[] {
    const now = this.now();
    const rows = this.d.db
      .prepare(
        `SELECT c.* FROM conversations c
         WHERE c.account_id = ? AND c.thread_type = 'user' AND c.assigned_off = 0 AND c.suggest_dismissed = 0
           AND c.last_message_at > ? AND c.last_message_at <= ?
           AND (c.suggest_checked_at = 0 OR (c.suggest_profile_id IS NULL AND c.last_message_at > c.suggest_checked_at + ?))
           AND EXISTS (SELECT 1 FROM messages m WHERE m.account_id = c.account_id AND m.thread_id = c.thread_id AND m.direction = 'in' AND m.text IS NOT NULL)
         ORDER BY c.last_message_at DESC LIMIT 50`,
      )
      .all(accountId, now - TRIAGE_LOOKBACK_MS, now - TRIAGE_QUIET_MS, DAY) as Record<string, unknown>[];
    const list = this.d.profiles.list(accountId);
    const offTag = this.d.profiles.offTag(accountId);
    const out: string[] = [];
    for (const c of rows) {
      const conv = c as never;
      if (resolveProfile(conv, list, labels, offTag).kind !== "none" || this.d.isAdmin?.(accountId, String(c.thread_id))) continue;
      out.push(String(c.thread_id));
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Xét một hội thoại: lưu gợi ý (hoặc "không") vào conversations. Trả id tính cách gợi ý hoặc null. */
  async triage(accountId: number, threadId: string): Promise<number | null> {
    const acc = this.d.account(accountId);
    const engine = this.d.engine();
    if (!acc || !engine) return null;
    const conv = acc.inbox.conversation(threadId);
    if (!conv) return null;
    const personas = forPrivate(this.d.profiles.list(accountId));
    if (!personas.length) return null;
    const messages = acc.inbox.messages(threadId, 20);
    const raw = await engine.generate({
      system: triageSystemPrompt(acc.ownerName(), personas),
      messages: [{ role: "user", content: triageUserPrompt(conv.name, messages, "Chủ") }],
    });
    const r = parseTriage(raw, personas.map((p) => p.id));
    const now = this.now();
    const save = this.d.db.prepare(
      "UPDATE conversations SET suggest_profile_id = ?, suggest_reason = ?, suggest_checked_at = ? WHERE account_id = ? AND thread_id = ?",
    );
    if (r.kind === "pick") {
      save.run(r.profileId, r.reason, now, accountId, threadId);
      return r.profileId;
    }
    save.run(null, r.kind === "none" ? r.reason : "", now, accountId, threadId);
    return null;
  }

  /** Chủ bấm "Bỏ qua" gợi ý: không gợi ý lại cho hội thoại này. */
  dismissSuggestion(accountId: number, threadId: string) {
    this.d.db
      .prepare("UPDATE conversations SET suggest_dismissed = 1, suggest_profile_id = NULL WHERE account_id = ? AND thread_id = ?")
      .run(accountId, threadId);
  }

  // ---------- Học hỏi đáp từ cách chủ trả lời ----------

  /**
   * Các lượt khách hỏi → chủ trả lời, mới nhất trước: chủ tự gõ (điện thoại, máy tính, trang quản trị) hoặc chủ sửa
   * nháp trợ lý rồi gửi. Chỉ chat riêng có nhãn tính cách này hoặc chưa có nhãn (bỏ "Không bot": thường là người nhà).
   */
  learnPairs(profileId: number, labels: unknown[] | null, since: number): LearnPair[] {
    const p = this.d.profiles.get(profileId);
    if (!p) return [];
    const acc = this.d.account(p.accountId);
    if (!acc) return [];
    const list = this.d.profiles.list(p.accountId);
    const offTag = this.d.profiles.offTag(p.accountId);
    const fits = (threadId: string) => {
      const conv = acc.inbox.conversation(threadId);
      if (!conv || conv.thread_type !== "user" || this.d.isAdmin?.(p.accountId, threadId)) return null;
      const r = resolveProfile(conv, list, labels, offTag);
      if (r.kind === "off" || (r.kind === "profile" && r.profile.id !== profileId)) return null;
      return conv;
    };
    const rows = this.d.db
      .prepare(
        `SELECT * FROM messages WHERE account_id = ? AND created_at >= ? AND (text IS NOT NULL OR direction = 'out')
         ORDER BY thread_id, created_at, id`,
      )
      .all(p.accountId, since) as unknown as (MessageRow & { account_id: number })[];
    const pairs: (LearnPair & { at: number })[] = [];
    let thread = "";
    let asked: string[] = [];
    let conv: ReturnType<typeof fits> = null;
    for (const m of rows) {
      if (m.thread_id !== thread) {
        thread = m.thread_id;
        asked = [];
        conv = fits(thread);
      }
      if (!conv) continue;
      if (m.direction === "in") {
        if (m.text) asked.push(m.text);
        continue;
      }
      const ownerTyped = m.source === "owner" && m.kind === "text";
      if (ownerTyped && asked.length && (m.text ?? "").trim().length >= MIN_ANSWER) {
        pairs.push({ threadName: conv.name, question: asked.slice(-3).join("\n"), answer: m.text!.trim(), at: m.created_at });
      }
      asked = [];
    }
    // Nháp trợ lý chủ sửa trước khi gửi: câu khách hỏi = các tin khách ngay trước lúc soạn nháp.
    for (const dr of this.d.assistant.editedDrafts(p.accountId, since)) {
      const c = fits(dr.threadId);
      if (!c) continue;
      const before = (
        this.d.db
          .prepare(
            "SELECT text FROM messages WHERE account_id = ? AND thread_id = ? AND direction = 'in' AND text IS NOT NULL AND created_at <= ? ORDER BY created_at DESC LIMIT 3",
          )
          .all(p.accountId, dr.threadId, dr.createdAt) as { text: string }[]
      )
        .map((r) => r.text)
        .reverse();
      if (!before.length) continue;
      pairs.push({ threadName: c.name, question: before.join("\n"), answer: dr.text, aiDraft: dr.originalText ?? undefined, at: dr.decidedAt ?? dr.createdAt });
    }
    // Nháp sửa đã gửi cũng nằm trong tin "ai" (không phải "owner") nên không bị đếm hai lần.
    return pairs
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_PAIRS)
      .map(({ at: _at, ...rest }) => rest);
  }

  /** Tìm gợi ý hỏi đáp mới cho một tính cách. Trả số gợi ý mới. */
  async learn(profileId: number): Promise<number> {
    const p = this.d.profiles.get(profileId);
    if (!p) throw new Error("Không có tính cách này");
    const engine = this.d.engine();
    if (!engine) throw new Error("Chưa cấu hình mô hình AI");
    const acc = this.d.account(p.accountId);
    const labels = (await acc?.labels().catch(() => null)) ?? null;
    const now = this.now();
    const pairs = this.learnPairs(profileId, labels, now - LEARN_LOOKBACK_MS);
    this.d.db.prepare("UPDATE profiles SET learned_at = ? WHERE id = ?").run(now, profileId);
    if (!pairs.length) return 0;
    const existing = [
      ...this.d.profiles.faqs(profileId),
      ...this.pendingSuggestions(profileId),
      ...(this.d.db.prepare("SELECT question, answer FROM faq_suggestions WHERE profile_id = ? AND status = 'dismissed' ORDER BY id DESC LIMIT 30").all(profileId) as {
        question: string;
        answer: string;
      }[]),
    ];
    const raw = await engine.generate({
      system: learnSystemPrompt(p.name, existing),
      messages: [{ role: "user", content: learnUserPrompt(pairs) }],
    });
    const found = parseLearned(raw);
    const ins = this.d.db.prepare("INSERT INTO faq_suggestions (profile_id, question, answer, evidence, created_at) VALUES (?, ?, ?, ?, ?)");
    for (const f of found) ins.run(profileId, f.question, f.answer, f.evidence, now);
    return found.length;
  }

  pendingSuggestions(profileId: number): FaqSuggestion[] {
    return (
      this.d.db.prepare("SELECT * FROM faq_suggestions WHERE profile_id = ? AND status = 'pending' ORDER BY id").all(profileId) as Record<string, unknown>[]
    ).map((r) => ({
      id: Number(r.id),
      profileId: Number(r.profile_id),
      question: String(r.question),
      answer: String(r.answer),
      evidence: String(r.evidence ?? ""),
      createdAt: Number(r.created_at),
    }));
  }

  /** Chủ duyệt gợi ý (có thể đã sửa chữ) → thành hỏi đáp tầng 2; hoặc bỏ. */
  decideSuggestion(profileId: number, id: number, accept: boolean, edit?: { question?: string; answer?: string }) {
    const s = this.pendingSuggestions(profileId).find((x) => x.id === id);
    if (!s) throw new Error("Gợi ý không còn chờ duyệt");
    if (accept) {
      const question = (edit?.question ?? s.question).trim();
      const answer = (edit?.answer ?? s.answer).trim();
      if (!question || !answer) throw new Error("Câu hỏi và câu trả lời không được trống");
      this.d.profiles.saveFaq(profileId, { question, answer });
    }
    this.d.db
      .prepare("UPDATE faq_suggestions SET status = ?, decided_at = ? WHERE id = ?")
      .run(accept ? "accepted" : "dismissed", this.now(), id);
  }

  learnedAt(profileId: number): number {
    const r = this.d.db.prepare("SELECT learned_at FROM profiles WHERE id = ?").get(profileId) as { learned_at: number } | undefined;
    return Number(r?.learned_at ?? 0);
  }

  // ---------- Chạy nền ----------

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.now();
      for (const id of this.d.accountIds()) {
        const acc = this.d.account(id);
        if (!acc?.isConnected() || this.d.assistant.isPaused(id) || !this.d.engine()) continue;
        if (!forPrivate(this.d.profiles.list(id)).length) continue;
        const labels = await acc.labels().catch(() => null);
        if (!labels) continue; // không đọc được nhãn thì chưa biết ai đã có nhãn
        // 1) Gợi ý nhãn: một khách mỗi lượt.
        const [thread] = this.triageCandidates(id, labels, 1);
        if (thread) {
          try {
            await this.triage(id, thread);
          } catch (err) {
            // Lỗi AI: đánh dấu đã xét để không gọi lại liên tục; khách nhắn lại sau một ngày sẽ được xét lại.
            this.d.db.prepare("UPDATE conversations SET suggest_checked_at = ? WHERE account_id = ? AND thread_id = ?").run(now, id, thread);
            this.d.log?.("Gợi ý nhãn lỗi", { thread, err: (err as Error).message });
          }
          return;
        }
        // 2) Học hỏi đáp: mỗi tính cách tối đa một lần mỗi ngày, khi có đủ lượt chủ trả lời mới.
        for (const p of forPrivate(this.d.profiles.list(id))) {
          const last = this.learnedAt(p.id);
          if (now - last < DAY) continue;
          if (this.learnPairs(p.id, labels, Math.max(last, now - LEARN_LOOKBACK_MS)).length < LEARN_AUTO_MIN_PAIRS) continue;
          try {
            const n = await this.learn(p.id);
            if (n > 0) this.d.assistant.notify(id, "draft", `Có ${n} gợi ý hỏi đáp mới cho tính cách "${p.name}", rút từ cách bạn trả lời khách. Vào Tính cách để duyệt.`);
          } catch (err) {
            this.d.db.prepare("UPDATE profiles SET learned_at = ? WHERE id = ?").run(now, p.id);
            this.d.log?.("Học hỏi đáp lỗi", { profile: p.id, err: (err as Error).message });
          }
          return;
        }
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
