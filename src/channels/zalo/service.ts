import type { FastifyBaseLogger } from "fastify";
import type { DB } from "../../server/db.js";
import type { Settings } from "../../server/settings.js";
import { ZaloChannel } from "./channel.js";
import { Inbox } from "./inbox.js";
import type { InboundEvent, ThreadType } from "./protocol.js";

/** Một tài khoản Zalo: nối kết nối với hộp thư, mọi tin đến/đi đều được lưu lại. */
export class ZaloService {
  readonly channel: ZaloChannel;
  readonly inbox: Inbox;
  /** Gọi sau khi một tin mới đã được ghi vào hộp thư (bộ trả lời AI nghe ở đây). */
  onRecorded?: (event: InboundEvent, sentByApp: boolean) => void;
  /** Gọi khi chủ gửi tin từ trang quản trị (để bỏ nháp AI đang chờ của hội thoại đó). */
  onOwnerSent?: (threadId: string) => void;

  constructor(db: DB, settings: Settings, dataDir: string, readonly accountId = 1, private readonly log?: FastifyBaseLogger) {
    this.inbox = new Inbox(db, accountId);
    this.channel = new ZaloChannel(settings, dataDir, accountId);
    this.channel.on("inbound", (event, { sentByApp }) => {
      void this.onInbound(event, sentByApp).catch((err) => this.log?.error({ err }, "Lỗi ghi tin Zalo"));
    });
    this.channel.on("status", (s) => this.log?.info({ state: s.state, error: s.error }, "Zalo"));
  }

  private async onInbound(event: InboundEvent, sentByApp: boolean) {
    let name: string | undefined;
    if (event.threadType === "group") name = await this.channel.groupName(event.threadId);
    else if (!event.isSelf && event.senderId === event.threadId) name = event.displayName;
    const added = this.inbox.recordInbound(event, { conversationName: name, sentByApp });
    if (added) this.onRecorded?.(event, sentByApp);
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

  /** Gửi tin lịch hẹn: ảnh trước, chữ sau; ghi vào hộp thư với nhãn "Lịch hẹn". */
  async send(target: { threadId: string; threadType: ThreadType; name: string }, text: string, imagePaths: string[]): Promise<void> {
    // Ảnh lỗi không được chặn phần chữ; lượt gửi vẫn báo lỗi để chủ biết ảnh chưa tới.
    let imageIds: string[] = [];
    let imageError: Error | null = null;
    try {
      imageIds = await this.channel.sendImages(target.threadId, target.threadType, imagePaths);
    } catch (err) {
      imageError = err as Error;
    }
    const textIds = text.trim() ? await this.channel.sendText(target.threadId, target.threadType, text) : [];
    const label = imagePaths.length && !imageError ? `[${imagePaths.length} ảnh] ` : "";
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
