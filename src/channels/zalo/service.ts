import type { FastifyBaseLogger } from "fastify";
import type { DB } from "../../server/db.js";
import type { Settings } from "../../server/settings.js";
import { MENTION_ALL_TEXT, ZaloChannel } from "./channel.js";
import type { SendOptions } from "../../scheduler/runner.js";
import { Inbox } from "./inbox.js";
import { ContactStore } from "../../core/contacts.js";
import { hasScheduleVars, renderScheduleText } from "../../scheduler/render.js";
import type { InboundEvent, ThreadType } from "./protocol.js";

/** Một tài khoản Zalo: nối kết nối với hộp thư, mọi tin đến/đi đều được lưu lại. */
export class ZaloService {
  readonly channel: ZaloChannel;
  readonly inbox: Inbox;
  /** Giới tính khách (anh / chị / bạn), lấy từ hồ sơ Zalo hoặc chủ sửa tay. */
  readonly contacts: ContactStore;
  /** Gọi sau khi một tin mới đã được ghi vào hộp thư (bộ trả lời AI nghe ở đây). */
  onRecorded?: (event: InboundEvent, sentByApp: boolean) => void;
  /** Gọi khi chủ gửi tin từ trang quản trị (để bỏ nháp AI đang chờ của hội thoại đó). */
  onOwnerSent?: (threadId: string) => void;

  constructor(db: DB, settings: Settings, dataDir: string, readonly accountId = 1, private readonly log?: FastifyBaseLogger) {
    this.inbox = new Inbox(db, accountId);
    this.channel = new ZaloChannel(settings, dataDir, accountId);
    this.contacts = new ContactStore(db, accountId, (ids) => this.channel.userProfiles(ids));
    this.channel.on("inbound", (event, { sentByApp }) => {
      void this.onInbound(event, sentByApp).catch((err) => this.log?.error({ err }, "Lỗi ghi tin Zalo"));
    });
    this.channel.on("status", (s) => {
      this.log?.info({ state: s.state, error: s.error }, "Zalo");
      // Vừa kết nối: lấy bù giới tính cho các khách chat riêng chưa có (chờ kết nối ổn định).
      if (s.state === "connected") setTimeout(() => void this.backfillContacts().catch(() => undefined), 15_000).unref();
    });
  }

  private async onInbound(event: InboundEvent, sentByApp: boolean) {
    let name: string | undefined;
    if (event.threadType === "group") name = await this.channel.groupName(event.threadId);
    else if (!event.isSelf && event.senderId === event.threadId) name = event.displayName;
    // Giới tính người nhắn: hỏi Zalo một lần, chạy nền (không làm chậm việc ghi tin). Bộ trả lời gom tin
    // vài giây rồi mới soạn nên thường đã có giới tính lúc soạn; chưa có thì gọi "bạn".
    if (!event.isSelf && event.senderId) void this.contacts.ensure([event.senderId]).catch(() => undefined);
    const added = this.inbox.recordInbound(event, { conversationName: name, sentByApp });
    if (added) this.onRecorded?.(event, sentByApp);
  }

  private backfilling = false;
  /** Khách chat riêng chưa có giới tính: hỏi Zalo theo lô 50, giãn 3 giây giữa các lô để không bị chặn. */
  private async backfillContacts() {
    if (this.backfilling || !this.isConnected()) return;
    this.backfilling = true;
    try {
      const ids = this.inbox
        .conversations(2000)
        .filter((c) => c.thread_type === "user")
        .map((c) => c.thread_id);
      const need = this.contacts.needsFetch(ids);
      for (let i = 0; i < need.length && this.isConnected(); i += 50) {
        await this.contacts.ensure(need.slice(i, i + 50));
        await new Promise((r) => setTimeout(r, 3000));
      }
    } finally {
      this.backfilling = false;
    }
  }

  /** Chủ tài khoản gửi tin từ trang quản trị. */
  async sendFromOwner(threadId: string, text: string): Promise<void> {
    const conv = this.inbox.conversation(threadId);
    const type: ThreadType = conv?.thread_type ?? "user";
    const ids = await this.channel.sendText(threadId, type, text);
    this.inbox.recordOutbound(threadId, type, text, "owner", ids[0] ?? null);
    this.onOwnerSent?.(threadId);
  }

  // ---- Dùng cho bộ chạy lịch ----
  isConnected(): boolean {
    return this.channel.isConnected();
  }

  /** Điền {xung_ho}, {Xung_ho}, {ten} cho đúng người nhận (lịch gửi nhiều người, mỗi người một tin riêng). */
  async personalize(target: { threadId: string; threadType: ThreadType; name: string }, text: string): Promise<string> {
    if (!hasScheduleVars(text)) return text;
    if (target.threadType === "group") return renderScheduleText(text, { isGroup: true, name: target.name || this.inbox.conversation(target.threadId)?.name || "" });
    await this.contacts.ensure([target.threadId]).catch(() => undefined);
    const c = this.contacts.get(target.threadId);
    const name = target.name || this.inbox.conversation(target.threadId)?.name || c?.name || "";
    return renderScheduleText(text, { isGroup: false, name, gender: c?.gender });
  }

  /** Gửi tin lịch hẹn: ảnh trước, chữ sau; ghi vào hộp thư với nhãn "Lịch hẹn". */
  async send(target: { threadId: string; threadType: ThreadType; name: string }, rawText: string, imagePaths: string[], opts?: SendOptions): Promise<void> {
    const urgency = opts?.urgency ?? 0;
    // Tag tất cả chỉ có ở nhóm; lịch chỉ có ảnh thì vẫn gửi một dòng "@All" để mọi người được báo.
    const mentionAll = Boolean(opts?.mentionAll) && target.threadType === "group";
    const text = await this.personalize(target, rawText);
    // Ảnh lỗi không được chặn phần chữ; lượt gửi vẫn báo lỗi để chủ biết ảnh chưa tới.
    let imageIds: string[] = [];
    let imageError: Error | null = null;
    try {
      imageIds = await this.channel.sendImages(target.threadId, target.threadType, imagePaths, { urgency });
    } catch (err) {
      imageError = err as Error;
    }
    const textIds = text.trim() || mentionAll ? await this.channel.sendText(target.threadId, target.threadType, text, { urgency, mentionAll }) : [];
    const label = (imagePaths.length && !imageError ? `[${imagePaths.length} ảnh] ` : "") + (mentionAll ? `${MENTION_ALL_TEXT} ` : "");
    this.inbox.recordOutbound(
      target.threadId,
      target.threadType,
      `${label}${text}`.trim(),
      "owner",
      textIds[0] ?? imageIds[0] ?? null,
      Date.now(),
      "scheduled",
      target.name || undefined,
    );
    if (imageError) {
      throw new Error(`Ảnh không gửi được: ${imageError.message}${text.trim() ? " (phần chữ đã gửi)" : ""}`);
    }
  }

  start() {
    return this.channel.start();
  }

  stop() {
    return this.channel.stop();
  }
}
