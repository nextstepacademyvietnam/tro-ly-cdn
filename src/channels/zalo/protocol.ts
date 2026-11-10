/**
 * Chuẩn hoá dữ liệu Zalo và các luật an toàn khi gửi/nhận.
 *
 * Port từ zalo-hermes `sidecar/protocol.mjs` (MIT, © 2026 Cong Thuan MMM, có chỉnh sửa
 * của Vũ Văn Hiếu): bỏ phần riêng của NSG (founder brand, workshop, thư ký công việc),
 * giữ phần chung đã kiểm chứng trên tài khoản thật.
 */

export type ThreadType = "user" | "group";

export interface InboundEvent {
  threadId: string;
  threadType: ThreadType;
  senderId: string;
  displayName: string;
  messageId: string;
  /** null khi không phải tin chữ (ảnh, file, sticker, thiệp…). */
  text: string | null;
  isText: boolean;
  /** Tin do chính tài khoản này gửi (từ điện thoại, máy tính hoặc từ app). */
  isSelf: boolean;
  mentions: string[];
  /** Loại nội dung thô từ Zalo, để hiển thị "[ảnh]", "[sticker]"… */
  msgType: string;
  /** Tin này trả lời (trích dẫn) tin của ai — dùng để biết khách đang reply trợ lý. */
  quoteOwnerId?: string;
  receivedAt: number;
}

export class OperationTimeoutError extends Error {
  readonly code = "operation_timeout";
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label = "operation"): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OperationTimeoutError(`${label} quá thời gian`)), Math.max(1, ms));
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function chunked<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

interface RawLabel {
  text?: unknown;
  conversations?: unknown;
}

/** Hội thoại có gắn nhãn Zalo (Phân loại) tên `labelName` không. Nhóm có thể mang tiền tố g / g-. */
export function conversationHasLabel(labels: unknown, labelName: string, threadId: string): boolean {
  const wanted = String(labelName ?? "").trim().toLocaleLowerCase("vi");
  const conversation = String(threadId ?? "");
  if (!wanted || !conversation || !Array.isArray(labels)) return false;
  const ids = new Set([conversation, `g${conversation}`, `g-${conversation}`]);
  if (conversation.startsWith("g-")) ids.add(conversation.slice(2));
  else if (/^g\d+$/.test(conversation)) ids.add(conversation.slice(1));
  return (labels as RawLabel[]).some((label) => {
    const name = String(label?.text ?? "").trim().toLocaleLowerCase("vi");
    const convs = Array.isArray(label?.conversations) ? label.conversations.map(String) : [];
    return name === wanted && convs.some((v) => ids.has(v));
  });
}

/** Cách xưng hô từ giới tính trong hồ sơ Zalo; không đoán từ tên. */
export function profileSalutation(profile: { gender?: unknown } | undefined): "anh" | "chị" | "bạn" {
  const g = profile?.gender;
  if (g === 0 || g === "0") return "anh";
  if (g === 1 || g === "1") return "chị";
  return "bạn";
}

/** Tin chủ tài khoản tự gửi vào "My Documents" (chat với chính mình) đôi khi mang threadId "0". */
export function canonicalizeSelfThread(event: InboundEvent, ownId: string): InboundEvent {
  if (event.isSelf && event.threadType === "user" && event.threadId === "0" && ownId && event.senderId === ownId) {
    return { ...event, threadId: ownId };
  }
  return event;
}

/** Tin chủ gõ trong "My Documents" = lệnh cho trợ lý (không phải tin do app gửi). */
export function isOwnerCommandChannel(event: InboundEvent, ownId: string, sentByApp: boolean): boolean {
  return (
    event.threadType === "user" && event.isSelf && !sentByApp && Boolean(ownId) &&
    event.threadId === ownId && event.senderId === ownId
  );
}

export function remainingQuietMs(deadlineMs: number | undefined, nowMs = Date.now()): number {
  return Math.max(0, Number(deadlineMs || 0) - nowMs);
}

function normalizedNoticeText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFC")
    .replace(/[​-‏⁠﻿]/gu, "") // ký tự định dạng vô hình trong thông báo hệ thống
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/[.!…]+$/u, "")
    .toLocaleLowerCase("vi");
}

function nestedStringValues(value: unknown, depth = 0): string[] {
  if (depth > 5 || value == null) return [];
  if (typeof value === "string") {
    const out = [value];
    const t = value.trim();
    if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
      try {
        out.push(...nestedStringValues(JSON.parse(t), depth + 1));
      } catch {
        /* chuỗi JSON hỏng của người dùng không phải thông báo hệ thống */
      }
    }
    return out;
  }
  if (Array.isArray(value)) return value.flatMap((v) => nestedStringValues(v, depth + 1));
  if (typeof value !== "object") return [];
  return Object.values(value).flatMap((v) => nestedStringValues(v, depth + 1));
}

interface RawMessage {
  type?: unknown;
  threadId?: unknown;
  isSelf?: unknown;
  data?: Record<string, unknown> & {
    content?: unknown;
    notify?: unknown;
    mentions?: unknown;
    quote?: unknown;
  };
}

/**
 * Thiệp sinh nhật Zalo là nội dung có cấu trúc, không phải tin chữ.
 * Không nhầm câu thường như "hôm nay là sinh nhật của mẹ tôi".
 */
export function birthdayNotice(message: RawMessage): { displayName: string } | null {
  const content = message?.data?.content;
  if (!content || typeof content !== "object") return null;
  for (const candidate of nestedStringValues(content)) {
    const m = /^hôm nay là sinh nhật của (.+)$/u.exec(normalizedNoticeText(candidate));
    if (m && m[1].trim()) return { displayName: m[1].trim() };
  }
  return null;
}

export function isFriendAcceptanceNotice(message: RawMessage): boolean {
  const data = message?.data ?? {};
  const candidates = [...nestedStringValues(data.content), ...nestedStringValues(data.notify)];
  for (const key of ["title", "text", "message", "description"]) candidates.push(...nestedStringValues(data[key]));
  return candidates.some((c) => {
    const t = normalizedNoticeText(c);
    return /^(?:.+? )?đã đồng ý kết bạn(?: với bạn)?$/u.test(t) || /^(?:bạn và .+?|.+? và bạn|hai bạn) đã trở thành bạn bè$/u.test(t);
  });
}

export function normalizeMessage(message: RawMessage, now = Date.now()): InboundEvent {
  const data = message?.data ?? {};
  const type = String(message?.type ?? "").toLowerCase();
  const content = typeof data.content === "string" ? data.content : null;
  const rawMentions = Array.isArray(data.mentions) ? (data.mentions as { uid?: unknown }[]) : [];
  return {
    threadId: String(message?.threadId ?? ""),
    threadType: type === "1" || type === "group" ? "group" : "user",
    senderId: String(data.uidFrom ?? data.userId ?? ""),
    displayName: String(data.dName ?? ""),
    messageId: String(data.msgId ?? data.cliMsgId ?? ""),
    text: content,
    isText: content !== null,
    isSelf: Boolean(message?.isSelf),
    mentions: rawMentions.map((m) => String(m?.uid ?? "")).filter(Boolean),
    msgType: String(data.msgType ?? ""),
    quoteOwnerId: (data.quote as { ownerId?: unknown } | undefined)?.ownerId ? String((data.quote as { ownerId?: unknown }).ownerId) : undefined,
    receivedAt: Number(data.ts) > 0 ? Number(data.ts) : now,
  };
}

/** Nhãn ngắn cho tin không phải chữ, để hiện trong hộp thư. */
export function describeNonText(msgType: string): string {
  const t = msgType.toLowerCase();
  if (t.includes("photo") || t.includes("image")) return "[Ảnh]";
  if (t.includes("sticker")) return "[Sticker]";
  if (t.includes("voice")) return "[Tin nhắn thoại]";
  if (t.includes("video")) return "[Video]";
  if (t.includes("file") || t.includes("share.file")) return "[Tệp]";
  if (t.includes("link")) return "[Liên kết]";
  if (t.includes("location")) return "[Vị trí]";
  return "[Nội dung không phải chữ]";
}

export function publicGroup(groupId: string, info: { name?: unknown; totalMember?: unknown } = {}) {
  return { id: String(groupId), name: String(info.name ?? "(không rõ tên)"), memberCount: Number(info.totalMember ?? 0) };
}

/** Zalo giới hạn độ dài tin; cắt theo đoạn, rồi theo câu, không cắt giữa chữ. */
export function splitLongText(text: string, max = 1800): string[] {
  const clean = text.trim();
  if (clean.length <= max) return clean ? [clean] : [];
  const parts: string[] = [];
  let rest = clean;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"));
    if (cut < max * 0.4) cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? ")) + 1;
    if (cut < max * 0.4) cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * Gom các tin liên tiếp của cùng một người trong một hội thoại tới khi họ ngừng gõ
 * `delayMs`, rồi xử lý một lần — khách hay nhắn nhiều dòng ngắn.
 */
export class MessageBatcher {
  private readonly buffers = new Map<string, InboundEvent[]>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly delayMs: number,
    private readonly onFlush: (merged: InboundEvent, parts: InboundEvent[]) => void | Promise<void>,
  ) {}

  private key(threadId: string, senderId: string) {
    return `${threadId}\u0000${senderId}`;
  }

  push(event: InboundEvent): void {
    const key = this.key(event.threadId, event.senderId);
    const list = this.buffers.get(key) ?? [];
    list.push(event);
    this.buffers.set(key, list);
    this.schedule(key);
  }

  /** Người đó đang gõ tiếp → lùi thời điểm xử lý. */
  touch(threadId: string, senderId: string): void {
    const key = this.key(threadId, senderId);
    if (this.buffers.has(key)) this.schedule(key);
  }

  private schedule(key: string) {
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => void this.flush(key), this.delayMs));
  }

  async flush(key: string): Promise<void> {
    const events = this.buffers.get(key) ?? [];
    this.buffers.delete(key);
    this.timers.delete(key);
    if (!events.length) return;
    const last = events[events.length - 1];
    const allText = events.every((e) => e.isText && typeof e.text === "string");
    const merged: InboundEvent = {
      ...last,
      text: allText ? events.map((e) => e.text).filter(Boolean).join("\n") : null,
      isText: allText,
      mentions: [...new Set(events.flatMap((e) => e.mentions))],
    };
    await this.onFlush(merged, events);
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.buffers.clear();
  }
}
