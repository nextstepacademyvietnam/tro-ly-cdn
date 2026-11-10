import type { Inbox } from "../channels/zalo/inbox.js";
import { type InboundEvent, MessageBatcher, type ThreadType, isOwnerCommandChannel } from "../channels/zalo/protocol.js";
import type { ChatMessage, Engine } from "../engines/index.js";
import type { AssistantStore } from "./assistantStore.js";
import type { Profile, ProfileStore } from "./profiles.js";
import { HANDOFF_MS, decide, fold, frameSystemPrompt, parseReply } from "./replyPolicy.js";

/** Những gì bộ trả lời cần từ một tài khoản Zalo (tách ra để test không cần Zalo thật). */
export interface ReplierAccount {
  accountId: number;
  inbox: Inbox;
  ownId(): string;
  ownerName(): string;
  isConnected(): boolean;
  labels(): Promise<unknown[] | null>;
  groupName(threadId: string): Promise<string>;
  sendText(threadId: string, type: ThreadType, text: string): Promise<string[]>;
  /** Ghi nhãn thật trong Zalo (null = gỡ các nhãn trong `exclusive`). */
  setLabel(threadId: string, type: ThreadType, target: string | null, exclusive: string[]): Promise<unknown>;
}

export interface ReplierOptions {
  /** Gom tin liên tiếp của một người tới khi họ ngừng nhắn ngần này (ms). */
  batchMs?: number;
  now?: () => number;
  log?: (msg: string, extra?: object) => void;
}

const HISTORY = 30;

/**
 * AI trả lời khách. Mỗi lượt tin của khách đi qua: gom tin → luật hệ thống (replyPolicy.decide)
 * → gọi AI với khung chung + tính cách + tài liệu → nháp chờ duyệt hoặc tự gửi.
 * Lỗi bất kỳ: không gửi gì cho khách, chỉ báo chủ.
 */
export class Replier {
  private readonly batchers = new Map<number, MessageBatcher>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly batchMs: number;
  private readonly log: (msg: string, extra?: object) => void;

  constructor(
    private readonly profiles: ProfileStore,
    private readonly store: AssistantStore,
    private readonly account: (id: number) => ReplierAccount | undefined,
    private readonly engine: () => Engine | null,
    opts: ReplierOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.batchMs = opts.batchMs ?? 7_000;
    this.log = opts.log ?? (() => {});
  }

  /** Gọi sau khi tin đã được ghi vào hộp thư. */
  onInbound(accountId: number, event: InboundEvent, sentByApp: boolean): void {
    if (sentByApp) return;
    const acc = this.account(accountId);
    if (!acc) return;
    if (event.isSelf) {
      if (isOwnerCommandChannel(event, acc.ownId(), false)) this.ownerCommand(acc, event);
      // Chủ tự trả lời → nháp đang chờ của hội thoại đó không còn đúng nữa.
      else this.store.supersede(accountId, event.threadId);
      return;
    }
    this.batcher(accountId).push(event);
  }

  /** Chủ gửi tin từ trang quản trị → nháp đang chờ của hội thoại không còn đúng. */
  ownerReplied(accountId: number, threadId: string): void {
    this.store.supersede(accountId, threadId);
  }

  /** Người kia đang gõ → lùi thời điểm trả lời. */
  onTyping(accountId: number, threadId: string, senderId: string): void {
    this.batchers.get(accountId)?.touch(threadId, senderId);
  }

  private batcher(accountId: number): MessageBatcher {
    let b = this.batchers.get(accountId);
    if (!b) {
      b = new MessageBatcher(this.batchMs, (merged) => this.enqueue(accountId, merged));
      this.batchers.set(accountId, b);
    }
    return b;
  }

  /** Mỗi hội thoại xử lý tuần tự, tránh hai câu trả lời chồng nhau. */
  private enqueue(accountId: number, event: InboundEvent): Promise<void> {
    const key = `${accountId}:${event.threadId}`;
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.then(() => this.process(accountId, event)).catch((err) => this.log("Lỗi trả lời", { err: String(err) }));
    this.queues.set(key, next);
    return next;
  }

  /** Xử lý một lượt (đã gom). Công khai để test. */
  async process(accountId: number, event: InboundEvent): Promise<void> {
    const acc = this.account(accountId);
    if (!acc) return;
    const conv = acc.inbox.conversation(event.threadId);
    if (!conv) return;
    const profiles = this.profiles.list(accountId);
    const labels = await acc.labels();
    const d = decide({
      event,
      conv,
      profiles,
      labels,
      offTag: this.profiles.offTag(accountId),
      paused: this.store.isPaused(accountId),
      ownId: acc.ownId(),
      lastOwnerAt: acc.inbox.lastOwnerAt(event.threadId),
      now: this.now(),
    });
    const who = conv.name || event.displayName || event.threadId;

    switch (d.act) {
      case "skip":
        return;
      case "resume":
        acc.inbox.clearHandoff(event.threadId);
        this.store.notify(accountId, "handoff", `${who} nhắn "trợ lý trả lời tiếp" — trợ lý đã trả lời lại hội thoại này.`, event.threadId);
        return;
      case "opt_out":
        acc.inbox.setNoProactive(event.threadId, true);
        this.store.notify(accountId, "opt_out", `${who} xin không nhận tin nữa. Đã đánh dấu "Không nhắn chủ động".`, event.threadId);
        return;
      case "group_stop": {
        const offTag = this.profiles.offTag(accountId);
        try {
          await acc.setLabel(event.threadId, "group", offTag, [...profiles.map((p) => p.tag).filter(Boolean), offTag]);
          this.store.notify(accountId, "group_stop", `Nhóm "${who}" yêu cầu trợ lý dừng. Đã gắn nhãn "${offTag}" cho nhóm trong Zalo.`, event.threadId);
        } catch (err) {
          acc.inbox.assign([event.threadId], "off"); // không ghi được nhãn thì vẫn phải im
          this.store.notify(accountId, "group_stop", `Nhóm "${who}" yêu cầu trợ lý dừng. Trợ lý đã dừng, nhưng chưa gắn được nhãn Zalo: ${(err as Error).message}`, event.threadId);
        }
        return;
      }
      case "handoff":
        this.handoff(acc, event, who, d.reason);
        return;
      case "reply":
        await this.reply(acc, event, d.profile, who);
    }
  }

  private handoff(acc: ReplierAccount, event: InboundEvent, who: string, reason: string) {
    acc.inbox.setHandoff(event.threadId, this.now() + HANDOFF_MS, reason);
    this.store.supersede(acc.accountId, event.threadId);
    const quote = event.text ? `: "${event.text.slice(0, 160)}"` : "";
    this.store.notify(acc.accountId, "handoff", `${who} cần người thật (${reason})${quote}. Trợ lý dừng ở hội thoại này 24 giờ.`, event.threadId);
  }

  private history(acc: ReplierAccount, threadId: string, isGroup: boolean): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (const m of acc.inbox.messages(threadId, HISTORY)) {
      const role = m.direction === "in" ? "user" : "assistant";
      let content = m.text ?? `[${m.kind.includes("photo") ? "ảnh" : "nội dung không phải chữ"}]`;
      if (isGroup && role === "user" && m.sender_name) content = `${m.sender_name}: ${content}`;
      const last = out[out.length - 1];
      if (last && last.role === role) last.content += `\n${content}`;
      else out.push({ role, content });
    }
    while (out.length && out[0].role !== "user") out.shift();
    return out;
  }

  private async reply(acc: ReplierAccount, event: InboundEvent, profile: Profile, who: string) {
    const engine = this.engine();
    if (!engine) {
      this.store.notify(acc.accountId, "error", `Chưa cấu hình mô hình AI nên trợ lý chưa trả lời ${who}.`, event.threadId);
      return;
    }
    const isGroup = event.threadType === "group";
    const messages = this.history(acc, event.threadId, isGroup);
    if (!messages.length || messages[messages.length - 1].role !== "user") return;
    const system =
      frameSystemPrompt({
        ownerName: acc.ownerName(),
        profileName: profile.name,
        isGroup,
        groupName: isGroup ? (await acc.groupName(event.threadId)) || who : "",
        personName: event.displayName,
        sendMode: profile.sendMode,
      }) +
      "\n\n" +
      this.profiles.compose(profile.id, undefined, this.now());

    let raw: string;
    try {
      raw = await engine.generate({ system, messages });
    } catch (err) {
      this.store.notify(acc.accountId, "error", `AI lỗi khi trả lời ${who}: ${(err as Error).message}. Không có tin nào được gửi.`, event.threadId);
      return;
    }
    const parsed = parseReply(raw);
    if (parsed.silent) return;
    // Trong nhóm, lời chuyển người thật không viết vào nhóm — chỉ báo chủ.
    const text = isGroup && parsed.handoff ? "" : parsed.text;

    if (parsed.handoff) this.handoff(acc, event, who, "AI thấy cần người thật");
    if (!text) return;

    if (profile.sendMode === "draft") {
      this.store.addDraft(acc.accountId, event.threadId, profile.id, text, parsed.handoff, this.now());
      return;
    }
    if (!acc.isConnected()) {
      this.store.addDraft(acc.accountId, event.threadId, profile.id, text, parsed.handoff, this.now());
      this.store.notify(acc.accountId, "error", `Zalo mất kết nối nên câu trả lời cho ${who} được giữ ở dạng nháp.`, event.threadId);
      return;
    }
    try {
      const ids = await acc.sendText(event.threadId, event.threadType, text);
      acc.inbox.recordOutbound(event.threadId, event.threadType, text, "ai", ids[0] ?? null, this.now());
    } catch (err) {
      this.store.addDraft(acc.accountId, event.threadId, profile.id, text, parsed.handoff, this.now());
      this.store.notify(acc.accountId, "error", `Gửi trả lời cho ${who} lỗi (${(err as Error).message}); câu trả lời được giữ ở dạng nháp.`, event.threadId);
    }
  }

  /** Lệnh chủ gõ trong My Documents (chat với chính mình). */
  private ownerCommand(acc: ReplierAccount, event: InboundEvent) {
    const t = fold(event.text ?? "").replace(/[.!?]+$/, "");
    if (t === "tam dung tro ly") {
      this.store.setPaused(acc.accountId, true);
      this.store.notify(acc.accountId, "command", "Đã tạm dừng trợ lý theo lệnh trong My Documents.");
    } else if (t === "tro ly chay lai") {
      this.store.setPaused(acc.accountId, false);
      this.store.notify(acc.accountId, "command", "Trợ lý chạy lại theo lệnh trong My Documents.");
    }
  }

  /** Chủ duyệt nháp: gửi (có thể đã sửa chữ). */
  async sendDraft(draftId: number, text?: string): Promise<void> {
    const d = this.store.draft(draftId);
    if (!d || d.status !== "pending") throw new Error("Nháp không còn chờ duyệt");
    const acc = this.account(d.accountId);
    if (!acc?.isConnected()) throw new Error("Zalo chưa kết nối");
    const conv = acc.inbox.conversation(d.threadId);
    const body = (text ?? d.text).trim();
    if (!body) throw new Error("Nội dung trống");
    try {
      const ids = await acc.sendText(d.threadId, conv?.thread_type ?? "user", body);
      acc.inbox.recordOutbound(d.threadId, conv?.thread_type ?? "user", body, "ai", ids[0] ?? null, this.now());
      this.store.decide(draftId, "sent", "", body);
    } catch (err) {
      this.store.decide(draftId, "failed", (err as Error).message);
      throw err;
    }
  }

  dispose() {
    for (const b of this.batchers.values()) b.dispose();
  }
}
