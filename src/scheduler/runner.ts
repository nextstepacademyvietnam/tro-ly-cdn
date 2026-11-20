import type { Schedule, ScheduleStore, ScheduleTarget, Urgency } from "./store.js";

/** Cách gửi của lịch: tag tất cả (chỉ nhóm), mức độ tin. */
export interface SendOptions {
  mentionAll: boolean;
  urgency: Urgency;
}

/** Nơi thực sự gửi tin (Zalo). Tách ra để test được bộ chạy lịch. */
export interface ScheduleSender {
  isConnected(accountId: number): boolean;
  send(accountId: number, target: ScheduleTarget, text: string, imagePaths: string[], opts?: SendOptions): Promise<void>;
}

/** AI soạn tin cho lịch "AI soạn" và đưa nháp vào hàng chờ duyệt. Gắn sau khi app có mô hình AI. */
export interface ScheduleComposer {
  /** Viết một tin mới theo chủ đề của lịch; `previous` = các tin đã viết gần đây (tránh lặp). */
  compose(s: Schedule, previous: string[]): Promise<string>;
  /** Đưa tin vào hàng chờ duyệt của hội thoại (thay nháp lịch này còn treo trước đó). */
  draft(s: Schedule, target: ScheduleTarget, text: string): Promise<void>;
}

export const GRACE_MS = 30 * 60_000;
export const TICK_MS = 15_000;

/**
 * Mỗi 15 giây tìm lịch đến hạn và gửi.
 * - Zalo chưa kết nối: chờ; trễ quá 30 phút thì ghi "Lỡ giờ" cho từng hội thoại.
 * - Lịch lặp luôn sang lượt kế tiếp sau khi xử lý.
 */
export class ScheduleRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private composer: ScheduleComposer | null = null;

  constructor(
    private readonly store: ScheduleStore,
    private readonly sender: ScheduleSender,
    private readonly log: (msg: string, extra?: object) => void = () => {},
  ) {}

  setComposer(c: ScheduleComposer | null): void {
    this.composer = c;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const s of this.store.due(now)) {
        const planned = s.nextRunAt!;
        const late = now - planned;
        if (late > GRACE_MS) {
          for (const t of s.targets) {
            this.store.addRun({ scheduleId: s.id, threadId: t.threadId, plannedAt: planned, status: "missed", error: "Lúc đến giờ, Zalo chưa kết nối hoặc app đang tắt", doneAt: now, manual: false });
          }
          this.store.advance(s.id, planned, now);
          this.log("Lịch lỡ giờ", { id: s.id });
          continue;
        }
        if (!this.sender.isConnected(s.accountId)) continue; // còn trong 30 phút gửi bù: chờ kết nối
        // Sang lượt kế tiếp trước khi gửi, để lỗi giữa chừng không làm gửi lặp.
        this.store.advance(s.id, planned, now);
        await this.sendToAll(s, planned, false);
      }
    } finally {
      this.running = false;
    }
  }

  /** Gửi ngay mọi hội thoại của lịch (nút "Gửi ngay"), không đổi lịch. */
  async sendNow(scheduleId: number): Promise<void> {
    const s = this.store.get(scheduleId);
    if (!s) throw new Error("Không có lịch này");
    if (!this.sender.isConnected(s.accountId)) throw new Error("Zalo chưa kết nối");
    await this.sendToAll(s, Date.now(), true);
  }

  /** Gửi lại một lượt bị lỗi hoặc lỡ giờ. */
  async retry(runId: number): Promise<void> {
    const run = this.store.run(runId);
    if (!run) throw new Error("Không có lượt gửi này");
    const s = this.store.get(run.scheduleId);
    if (!s) throw new Error("Lịch đã bị xoá");
    const target = s.targets.find((t) => t.threadId === run.threadId) ?? { threadId: run.threadId, threadType: "user" as const, name: "" };
    if (!this.sender.isConnected(s.accountId)) throw new Error("Zalo chưa kết nối");
    try {
      // Lịch AI soạn: gửi lại đúng tin đã viết ở lượt đó; lượt chưa viết được thì viết mới.
      const text = s.aiMode === "off" ? s.text : run.text || (await this.compose(s));
      await this.sender.send(s.accountId, target, text, s.aiMode === "off" ? this.imagePaths(s) : [], { mentionAll: s.mentionAll, urgency: s.urgency });
      this.store.updateRun(runId, "sent", "");
    } catch (err) {
      this.store.updateRun(runId, "failed", (err as Error).message);
      throw err;
    }
  }

  private imagePaths(s: Schedule): string[] {
    return s.imageIds.flatMap((id) => {
      const m = this.store.media(id);
      return m ? [this.store.mediaPath(m)] : [];
    });
  }

  private async compose(s: Schedule): Promise<string> {
    if (!this.composer) throw new Error("Chưa có mô hình AI để soạn tin (Cài đặt → Mô hình AI)");
    const text = (await this.composer.compose(s, this.store.recentTexts(s.id))).trim();
    if (!text) throw new Error("AI không viết ra nội dung");
    return text;
  }

  private async sendToAll(s: Schedule, planned: number, manual: boolean) {
    if (s.aiMode !== "off") return this.composeForAll(s, planned, manual);
    const images = this.imagePaths(s);
    for (const t of s.targets) {
      try {
        await this.sender.send(s.accountId, t, s.text, images, { mentionAll: s.mentionAll, urgency: s.urgency });
        this.store.addRun({ scheduleId: s.id, threadId: t.threadId, plannedAt: planned, status: "sent", error: "", doneAt: Date.now(), manual });
      } catch (err) {
        this.store.addRun({ scheduleId: s.id, threadId: t.threadId, plannedAt: planned, status: "failed", error: (err as Error).message, doneAt: Date.now(), manual });
        this.log("Gửi lịch lỗi", { id: s.id, error: (err as Error).message });
      }
    }
  }

  /** Lịch AI soạn: viết MỘT tin cho lượt này (biến {tên}, {xưng hô} vẫn điền riêng từng nơi lúc gửi), rồi chờ duyệt hoặc tự gửi. */
  private async composeForAll(s: Schedule, planned: number, manual: boolean) {
    let text: string;
    try {
      text = await this.compose(s);
    } catch (err) {
      const error = `AI không soạn được: ${(err as Error).message}`;
      for (const t of s.targets) this.store.addRun({ scheduleId: s.id, threadId: t.threadId, plannedAt: planned, status: "failed", error, doneAt: Date.now(), manual });
      this.log("Lịch AI soạn lỗi", { id: s.id, error });
      return;
    }
    for (const t of s.targets) {
      try {
        if (s.aiMode === "draft") {
          await this.composer!.draft(s, t, text);
          this.store.addRun({ scheduleId: s.id, threadId: t.threadId, plannedAt: planned, status: "drafted", error: "", doneAt: Date.now(), manual, text });
        } else {
          await this.sender.send(s.accountId, t, text, [], { mentionAll: s.mentionAll, urgency: s.urgency });
          this.store.addRun({ scheduleId: s.id, threadId: t.threadId, plannedAt: planned, status: "sent", error: "", doneAt: Date.now(), manual, text });
        }
      } catch (err) {
        this.store.addRun({ scheduleId: s.id, threadId: t.threadId, plannedAt: planned, status: "failed", error: (err as Error).message, doneAt: Date.now(), manual, text });
        this.log("Gửi lịch lỗi", { id: s.id, error: (err as Error).message });
      }
    }
  }
}
