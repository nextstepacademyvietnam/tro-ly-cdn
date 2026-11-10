import { describe, expect, it, vi } from "vitest";
import { openDb } from "../../server/db.js";
import { Inbox } from "./inbox.js";
import { SendPacer, inQuietHours, typingDelayMs } from "./pacing.js";
import {
  MessageBatcher,
  birthdayNotice,
  canonicalizeSelfThread,
  conversationHasLabel,
  isFriendAcceptanceNotice,
  isOwnerCommandChannel,
  normalizeMessage,
  profileSalutation,
  splitLongText,
  withTimeout,
  type InboundEvent,
} from "./protocol.js";

// Các ca dưới đây port từ tests/node/protocol.test.mjs của zalo-hermes (MIT).
describe("chuẩn hoá tin Zalo", () => {
  it("tin chữ trong chat riêng", () => {
    const e = normalizeMessage({ type: 0, threadId: "user-1", isSelf: false, data: { uidFrom: "user-1", msgId: "m-1", content: "xin chào", dName: "Khách" } });
    expect(e).toMatchObject({ threadType: "user", isText: true, text: "xin chào", displayName: "Khách", messageId: "m-1" });
  });

  it("ảnh và mention trong nhóm", () => {
    const e = normalizeMessage({ type: 1, threadId: "group-1", data: { uidFrom: "user-2", msgId: "m-2", content: { type: "image" }, mentions: [{ uid: "bot-1" }] } });
    expect(e).toMatchObject({ threadType: "group", isText: false, text: null, mentions: ["bot-1"] });
  });

  it("tin chủ tự gửi vào My Documents có threadId 0 được đưa về id của chủ", () => {
    const e = normalizeMessage({ type: 0, threadId: "0", isSelf: true, data: { uidFrom: "me", msgId: "m", content: "nhắc tôi" } });
    const c = canonicalizeSelfThread(e, "me");
    expect(c.threadId).toBe("me");
    expect(isOwnerCommandChannel(c, "me", false)).toBe(true);
    expect(isOwnerCommandChannel(c, "me", true)).toBe(false);
  });

  it("thông báo kết bạn không phải tin của khách", () => {
    expect(isFriendAcceptanceNotice({ data: { content: "Nguyễn Văn A đã đồng ý kết bạn." } })).toBe(true);
    expect(isFriendAcceptanceNotice({ data: { content: "Bạn và Nguyễn Văn A đã trở thành bạn bè" } })).toBe(true);
    expect(isFriendAcceptanceNotice({ data: { content: { title: "Hai bạn đã trở thành bạn bè!" } } })).toBe(true);
    expect(isFriendAcceptanceNotice({ data: { content: JSON.stringify({ title: "Nguyễn Văn Tuấn đã đồng ý kết bạn" }) } })).toBe(true);
    expect(isFriendAcceptanceNotice({ data: { notify: "Nguyễn Văn Tuấn​ đã đồng ý kết bạn" } })).toBe(true);
    expect(isFriendAcceptanceNotice({ data: { content: "Tôi đồng ý kết bạn" } })).toBe(false);
    expect(isFriendAcceptanceNotice({ data: { content: "Khách đã đồng ý kết bạn với nhân viên chưa?" } })).toBe(false);
  });

  it("thiệp sinh nhật là sự kiện hệ thống, câu thường thì không", () => {
    expect(
      birthdayNotice({ type: 0, threadId: "u1", data: { content: { title: "Hôm nay là sinh nhật của Văn Hiếu", subtitle: "Gửi sticker" } } }),
    ).toEqual({ displayName: "văn hiếu" });
    expect(birthdayNotice({ data: { content: "Hôm nay là sinh nhật của mẹ tôi" } })).toBeNull();
    expect(birthdayNotice({ data: { content: { title: "Ngày mai là sinh nhật của Văn Hiếu" } } })).toBeNull();
  });

  it("xưng hô theo giới tính hồ sơ, không rõ thì 'bạn'", () => {
    expect(profileSalutation({ gender: 0 })).toBe("anh");
    expect(profileSalutation({ gender: "1" })).toBe("chị");
    expect(profileSalutation({})).toBe("bạn");
  });

  it("nhãn hội thoại khớp cả id nhóm có tiền tố g", () => {
    const labels = [{ text: "Khách VIP", conversations: ["g123", "u9"] }];
    expect(conversationHasLabel(labels, "khách vip", "123")).toBe(true);
    expect(conversationHasLabel(labels, "Khách VIP", "u9")).toBe(true);
    expect(conversationHasLabel(labels, "Khách VIP", "u8")).toBe(false);
    expect(conversationHasLabel(null, "Khách VIP", "u9")).toBe(false);
  });
});

describe("chia tin dài", () => {
  it("tin ngắn giữ nguyên, tin dài chia ở ranh giới câu", () => {
    expect(splitLongText("  chào  ")).toEqual(["chào"]);
    const long = Array.from({ length: 60 }, (_, i) => `Câu số ${i} khá là dài một chút.`).join(" ");
    const parts = splitLongText(long, 300);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 300)).toBe(true);
    expect(parts.join(" ")).toBe(long);
    expect(parts.slice(0, -1).every((p) => p.endsWith("."))).toBe(true);
  });
});

describe("gom tin liên tiếp", () => {
  const ev = (id: string, text: string | null): InboundEvent => ({
    threadId: "t", threadType: "user", senderId: "s", displayName: "", messageId: id,
    text, isText: text !== null, isSelf: false, mentions: [], msgType: "", receivedAt: 0,
  });

  it("gộp các dòng ngắn thành một lượt, lùi khi người đó đang gõ", async () => {
    vi.useFakeTimers();
    const flushed: InboundEvent[] = [];
    const b = new MessageBatcher(1000, (m) => void flushed.push(m));
    b.push(ev("1", "cho mình hỏi"));
    await vi.advanceTimersByTimeAsync(800);
    b.touch("t", "s");
    b.push(ev("2", "giá bao nhiêu"));
    await vi.advanceTimersByTimeAsync(900);
    expect(flushed).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toMatchObject({ text: "cho mình hỏi\ngiá bao nhiêu", messageId: "2" });
    vi.useRealTimers();
  });

  it("có ảnh xen giữa thì không ghép chữ", async () => {
    const out: InboundEvent[] = [];
    const b = new MessageBatcher(10, (m) => void out.push(m));
    b.push(ev("1", "đây"));
    b.push(ev("2", null));
    await b.flush("t\u0000s");
    expect(out[0]).toMatchObject({ isText: false, text: null });
  });
});

describe("nhịp gửi an toàn", () => {
  it("giữ khoảng cách tối thiểu và chặn khi chạm trần giờ", () => {
    const p = new SendPacer({ minGapMs: 1000, maxPerHour: 3, maxPerDay: 100, quietStartHour: 22, quietEndHour: 7 });
    const t = Date.UTC(2026, 10, 10, 5, 0, 0); // 12h trưa giờ VN
    expect(p.reserve(t)).toEqual({ ok: true, waitMs: 0 });
    expect(p.reserve(t)).toEqual({ ok: true, waitMs: 1000 });
    expect(p.reserve(t + 5000)).toEqual({ ok: true, waitMs: 0 });
    expect(p.reserve(t + 6000).ok).toBe(false);
  });

  it("giờ yên lặng chỉ chặn tin chủ động", () => {
    const night = Date.UTC(2026, 10, 10, 16, 0, 0); // 23h giờ VN
    expect(inQuietHours(night, { quietStartHour: 22, quietEndHour: 7 })).toBe(true);
    const p = new SendPacer();
    expect(p.reserve(night, true).ok).toBe(false);
    expect(p.reserve(night, false).ok).toBe(true);
  });

  it("thời gian gõ tăng theo độ dài nhưng có trần", () => {
    expect(typingDelayMs("ok")).toBe(1200);
    expect(typingDelayMs("x".repeat(10_000))).toBe(8000);
  });

  it("withTimeout báo quá thời gian", async () => {
    await expect(withTimeout(new Promise(() => {}), 10, "Gửi tin")).rejects.toThrow(/quá thời gian/);
  });
});

describe("hộp thư", () => {
  const base = (over: Partial<InboundEvent>): InboundEvent => ({
    threadId: "u1", threadType: "user", senderId: "u1", displayName: "Lan", messageId: "m1",
    text: "chào shop", isText: true, isSelf: false, mentions: [], msgType: "webchat", receivedAt: 1000, ...over,
  });

  it("lưu tin đến, bỏ tin trùng, đếm chưa đọc", () => {
    const inbox = new Inbox(openDb(":memory:"), 1);
    expect(inbox.recordInbound(base({}), { conversationName: "Lan" })).toBe(true);
    expect(inbox.recordInbound(base({}))).toBe(false);
    inbox.recordInbound(base({ messageId: "m2", text: null, isText: false, msgType: "chat.photo", receivedAt: 2000 }));
    const [c] = inbox.conversations();
    expect(c).toMatchObject({ thread_id: "u1", name: "Lan", unread: 2, last_text: "[Ảnh]", assigned_profile_id: null, assigned_off: 0 });
    inbox.markRead("u1");
    expect(inbox.conversation("u1")?.unread).toBe(0);
  });

  it("tin chủ tự gõ trên điện thoại ghi là 'owner', tin app vừa gửi không ghi đôi", () => {
    const inbox = new Inbox(openDb(":memory:"), 1);
    inbox.recordInbound(base({}));
    inbox.recordInbound(base({ messageId: "m2", isSelf: true, senderId: "me", text: "dạ chào chị", receivedAt: 2000 }));
    inbox.recordOutbound("u1", "user", "AI trả lời", "ai", "m3", 3000);
    expect(inbox.recordInbound(base({ messageId: "m3", isSelf: true, text: "AI trả lời", receivedAt: 3000 }), { sentByApp: true })).toBe(false);
    const msgs = inbox.messages("u1");
    expect(msgs.map((m) => [m.direction, m.source])).toEqual([
      ["in", "zalo"],
      ["out", "owner"],
      ["out", "ai"],
    ]);
    expect(inbox.conversation("u1")).toMatchObject({ unread: 1, last_text: "AI trả lời" });
  });
});
