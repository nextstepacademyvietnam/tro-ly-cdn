import { describe, expect, it } from "vitest";
import { openDb } from "../server/db.js";
import { Inbox } from "../channels/zalo/inbox.js";
import type { InboundEvent } from "../channels/zalo/protocol.js";
import type { Engine } from "../engines/index.js";
import { AssistantStore } from "../core/assistantStore.js";
import { ProfileStore } from "../core/profiles.js";
import { Replier, type ReplierAccount } from "../core/replier.js";
import { AdminCommands, AdminStore, commandText, parseActions } from "./commands.js";
import { Reports } from "./reports.js";

// 19/11/2026 10:00 giờ VN
const NOW = Date.UTC(2026, 10, 19, 3, 0, 0);

function setup(aiReply = "<tra_loi>Chào anh</tra_loi>") {
  const db = openDb(":memory:");
  const inbox = new Inbox(db, 1);
  const profiles = new ProfileStore(db);
  const store = new AssistantStore(db);
  profiles.update(1, { name: "Chăm sóc khách hàng", tag: "Bot CSKH", identity: {}, sendMode: "draft", applies: "both", priority: 1 });
  let now = NOW;
  const sent: { thread: string; text: string }[] = [];
  const labelWrites: { thread: string; target: string | null }[] = [];
  const acc: ReplierAccount = {
    accountId: 1,
    inbox,
    ownId: () => "me",
    ownerName: () => "chị Thảo",
    isConnected: () => true,
    labels: async () => [{ text: "Bot CSKH", conversations: [] }],
    groupName: async () => "",
    sendText: async (thread, _t, text) => (sent.push({ thread, text }), [`s${sent.length}`]),
    setLabel: async (thread, _t, target) => void labelWrites.push({ thread, target }),
    salutation: () => "anh",
  };
  const prompts: string[] = [];
  let answer = aiReply;
  const engine: Engine = { kind: "codex", generate: async (r) => (prompts.push(r.messages.map((m) => m.content).join("\n")), answer) };
  const admins = new AdminStore(db);
  const reports = new Reports({ db, assistant: store, accountIds: () => [1], account: () => acc, adminIds: (id) => admins.ids(id), now: () => now });
  const cmds = new AdminCommands({ admins, profiles, assistant: store, reports, account: () => acc, engine: () => engine, now: () => now });
  const replier = new Replier(profiles, store, () => acc, () => engine, { batchMs: 0, now: () => now });
  replier.admin = cmds;
  let n = 0;
  const say = async (from: string, text: string, opts: { self?: boolean } = {}) => {
    const e: InboundEvent = {
      threadId: from, threadType: "user", senderId: from, displayName: from, messageId: `m${n++}`,
      text, isText: true, isSelf: Boolean(opts.self), mentions: [], msgType: "webchat", receivedAt: now,
    };
    inbox.recordInbound(e, { conversationName: from === "coach" ? "Coach Duy" : from === "me" ? "Cloud" : `Khách ${from}` });
    replier.onInbound(1, e, false);
    await new Promise((r) => setTimeout(r, 40));
  };
  return { db, inbox, profiles, store, admins, reports, cmds, sent, labelWrites, prompts, say, setAnswer: (t: string) => (answer = t), setNow: (t: number) => (now = t) };
}

describe("lệnh admin qua Zalo", () => {
  it("Cloud của tôi chỉ là lệnh khi có tiền tố; người lạ gõ lệnh thì không làm", () => {
    expect(commandText("bot hôm nay thế nào")).toBe("hôm nay thế nào");
    expect(commandText("/tạm dừng")).toBe("tạm dừng");
    expect(commandText("Trợ lý, báo cáo tuần")).toBe("báo cáo tuần");
    expect(commandText("ghi chú: mua sữa")).toBeNull();
    expect(commandText("hôm nay bot thế nào")).toBe("hôm nay bot thế nào");
    expect(commandText("robot hút bụi")).toBeNull();
  });

  it("đọc thẻ hành động AI trả về", () => {
    const a = parseActions(
      '<thong_tin ma="1" het_han="2026-11-30">Giảm 30% khoá Sales Bứt Phá</thong_tin><gan_nhan khach="anh Nam" ma="tat"/><so_lieu ky="tuan"/><hoi_dap ma="1"><hoi>Học online?</hoi><dap>Có, qua Zoom</dap></hoi_dap>',
    );
    expect(a).toEqual([
      { kind: "note", profileId: 1, text: "Giảm 30% khoá Sales Bứt Phá", expiresOn: "2026-11-30" },
      { kind: "label", customer: "anh Nam", target: "off" },
      { kind: "stats", period: "weekly" },
      { kind: "faq", profileId: 1, question: "Học online?", answer: "Có, qua Zoom" },
    ]);
  });

  it("admin nhắn → thêm thông tin tầng 3, trả lời rõ; hoàn tác thì gỡ; tin admin không vào luồng trả lời khách", async () => {
    const t = setup('<thong_tin ma="1" het_han="2026-11-30">Giảm 30% khoá Sales Bứt Phá tới hết 30/11</thong_tin>');
    t.admins.add(1, "coach", "Coach Duy");
    await t.say("coach", "thêm khuyến mãi giảm 30% tới hết 30/11");
    expect(t.profiles.notes(1).map((x) => x.text)).toEqual(["Giảm 30% khoá Sales Bứt Phá tới hết 30/11"]);
    expect(t.sent.at(-1)).toMatchObject({ thread: "coach" });
    expect(t.sent.at(-1)!.text).toContain("Đã thêm thông tin thời điểm");
    expect(t.store.pending(1)).toHaveLength(0);
    await t.say("coach", "hoàn tác");
    expect(t.profiles.notes(1)).toHaveLength(0);
    expect(t.sent.at(-1)!.text).toContain("Đã hoàn tác");
  });

  it("người không phải admin gõ y hệt → không làm gì", async () => {
    const t = setup('<tam_dung/>');
    await t.say("la", "tạm dừng trợ lý");
    expect(t.store.isPaused(1)).toBe(false);
    expect(t.prompts).toHaveLength(0);
  });

  it("Cloud của tôi: 'bot tạm dừng' → tạm dừng; ghi chú thường thì bỏ qua", async () => {
    const t = setup("<tam_dung/>");
    await t.say("me", "nhớ gọi anh Long", { self: true });
    expect(t.prompts).toHaveLength(0);
    await t.say("me", "bot tạm dừng trợ lý", { self: true });
    expect(t.store.isPaused(1)).toBe(true);
    expect(t.sent.at(-1)!.thread).toBe("me");
  });

  it("My Documents có mã riêng khác mã nick: lần đầu cần mở đầu bằng bot, học mã rồi thì bot giữa câu cũng được", async () => {
    const t = setup("<so_lieu ky=\"ngay\"/>");
    const self = async (text: string) => {
      t.inbox.recordInbound({ threadId: "cloud9", threadType: "user", senderId: "me", displayName: "", messageId: `c${Math.random()}`, text, isText: true, isSelf: true, mentions: [], msgType: "webchat", receivedAt: NOW });
      const r = t.cmds.route(1, { threadId: "cloud9", threadType: "user", senderId: "me", displayName: "", messageId: "z", text, isText: true, isSelf: true, mentions: [], msgType: "webchat", receivedAt: NOW }, "me");
      return r;
    };
    expect(await self("hôm nay bot thế nào")).toBeNull();
    expect(await self("bot hôm nay thế nào")).toEqual({ thread: "cloud9", text: "hôm nay thế nào" });
    expect(t.admins.cloudThread(1)).toBe("cloud9");
    expect(await self("hôm nay bot thế nào")).toEqual({ thread: "cloud9", text: "hôm nay bot thế nào" });
  });

  it("gắn nhãn theo tên khách; trùng nhiều người thì hỏi lại, không gắn", async () => {
    const t = setup('<gan_nhan khach="Nam" ma="1"/>');
    t.admins.add(1, "coach", "Coach Duy");
    t.inbox.recordInbound(
      { threadId: "k1", threadType: "user", senderId: "k1", displayName: "", messageId: "x1", text: "Chào", isText: true, isSelf: false, mentions: [], msgType: "webchat", receivedAt: NOW - 1000 },
      { conversationName: "Trần Văn Nam" },
    );
    await t.say("coach", "gắn bot cskh cho Nam");
    expect(t.labelWrites).toEqual([{ thread: "k1", target: "Bot CSKH" }]);
    t.inbox.recordInbound(
      { threadId: "k2", threadType: "user", senderId: "k2", displayName: "", messageId: "x2", text: "Hi", isText: true, isSelf: false, mentions: [], msgType: "webchat", receivedAt: NOW - 1000 },
      { conversationName: "Lê Nam" },
    );
    await t.say("coach", "gắn bot cskh cho Nam");
    expect(t.labelWrites).toHaveLength(1);
    expect(t.sent.at(-1)!.text).toContain("Có 2 khách khớp");
  });
});

describe("báo cáo định kỳ", () => {
  it("tạo báo cáo: chỉ nhận người là admin hoặc chính nick; cần ít nhất một chỉ số", () => {
    const t = setup();
    t.admins.add(1, "coach", "Coach Duy");
    expect(() => t.reports.save(1, { metrics: [] })).toThrow(/chỉ số/);
    const r = t.reports.save(1, { name: "Tuần", frequency: "weekly", weekday: 1, atMinute: 8 * 60, recipients: ["self", "coach", "la"], metrics: ["messages", "waiting"] });
    expect(r.recipients).toEqual(["self", "coach"]);
  });

  it("tới giờ thì gửi một lần mỗi kỳ, đúng chỉ số, không tính chat admin là khách", async () => {
    const t = setup();
    t.admins.add(1, "coach", "Coach Duy");
    t.reports.save(1, { name: "Hằng ngày", frequency: "daily", atMinute: 10 * 60 + 30, recipients: ["self", "coach"], metrics: ["messages", "pending"] });
    t.inbox.recordInbound(
      { threadId: "k1", threadType: "user", senderId: "k1", displayName: "", messageId: "y1", text: "Giá?", isText: true, isSelf: false, mentions: [], msgType: "webchat", receivedAt: NOW - 60_000 },
      { conversationName: "Khách" },
    );
    t.inbox.recordInbound(
      { threadId: "coach", threadType: "user", senderId: "coach", displayName: "", messageId: "y2", text: "bot ơi", isText: true, isSelf: false, mentions: [], msgType: "webchat", receivedAt: NOW - 60_000 },
      { conversationName: "Coach Duy" },
    );
    await t.reports.tick();
    expect(t.sent).toHaveLength(0); // 10:00 < 10:30
    t.setNow(NOW + 31 * 60_000);
    await t.reports.tick();
    await t.reports.tick();
    expect(t.sent.map((s) => s.thread)).toEqual(["me", "coach"]);
    expect(t.sent[0]!.text).toContain("Tin khách nhắn riêng: 1 tin từ 1 người");
    expect(t.sent[0]!.text).toContain("Nháp đang chờ duyệt: 0");
    expect(t.sent[0]!.text).not.toContain("Khách chờ");
  });

  it("báo cáo tuần chỉ gửi đúng thứ đã chọn", async () => {
    const t = setup();
    t.reports.save(1, { frequency: "weekly", weekday: 1, atMinute: 9 * 60, metrics: ["messages"] }); // Thứ Hai
    await t.reports.tick(); // 19/11/2026 là Thứ Năm
    expect(t.sent).toHaveLength(0);
    t.setNow(NOW + 4 * 86_400_000); // Thứ Hai 23/11
    await t.reports.tick();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.text).toContain("7 ngày qua");
  });
});
