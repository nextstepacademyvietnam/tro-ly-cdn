import { describe, expect, it } from "vitest";
import { EMPTY_IDENTITY } from "./promptLayers.js";
import { openDb } from "../server/db.js";
import { Inbox } from "../channels/zalo/inbox.js";
import type { InboundEvent } from "../channels/zalo/protocol.js";
import type { Engine, GenerateRequest } from "../engines/index.js";
import { AssistantStore } from "./assistantStore.js";
import { ProfileStore } from "./profiles.js";
import { Replier, type ReplierAccount } from "./replier.js";
import { decide, fold, handoffTopic, parseReply, type PolicyInput } from "./replyPolicy.js";

const NOW = Date.UTC(2026, 10, 10, 5, 0, 0);
const OWN = "me";

const ev = (over: Partial<InboundEvent> = {}): InboundEvent => ({
  threadId: "u1", threadType: "user", senderId: "u1", displayName: "Lan", messageId: `m${Math.random()}`,
  text: "Khoá học bao nhiêu tiền?", isText: true, isSelf: false, mentions: [], msgType: "webchat", receivedAt: NOW - 1000, ...over,
});

describe("luật hệ thống trước khi gọi AI", () => {
  const profile = { id: 1, accountId: 1, name: "CSKH", tag: "Bot CSKH", identity: EMPTY_IDENTITY, sendMode: "draft" as const, applies: "both" as const, priority: 1, updatedAt: 0 };
  const labels = [{ text: "Bot CSKH", conversations: ["u1", "g9"] }];
  const base = (over: Partial<PolicyInput> = {}): PolicyInput => ({
    event: ev(),
    conv: { thread_id: "u1", thread_type: "user", assigned_profile_id: null, assigned_off: 0, handoff_until: 0 },
    profiles: [profile], labels, offTag: "Không bot", paused: false, ownId: OWN, lastOwnerAt: 0, now: NOW, ...over,
  });

  it("có nhãn → trả lời; không nhãn, tạm dừng, tin cũ → im", () => {
    expect(decide(base()).act).toBe("reply");
    expect(decide(base({ labels: [] }))).toMatchObject({ act: "skip", reason: expect.stringMatching(/chưa gắn/) });
    expect(decide(base({ labels: null }))).toMatchObject({ act: "skip" });
    expect(decide(base({ paused: true }))).toMatchObject({ act: "skip", reason: expect.stringMatching(/tạm dừng/) });
    expect(decide(base({ event: ev({ receivedAt: NOW - 11 * 60_000 }) }))).toMatchObject({ act: "skip", reason: expect.stringMatching(/cũ/) });
  });

  it("chủ vừa nhắn tay 30 phút → im; đang chờ người thật → im, trừ câu mở lại", () => {
    expect(decide(base({ lastOwnerAt: NOW - 10 * 60_000 })).act).toBe("skip");
    expect(decide(base({ lastOwnerAt: NOW - 31 * 60_000 })).act).toBe("reply");
    const waiting = { thread_id: "u1", thread_type: "user" as const, assigned_profile_id: null, assigned_off: 0, handoff_until: NOW + 1000 };
    expect(decide(base({ conv: waiting })).act).toBe("skip");
    expect(decide(base({ conv: waiting, event: ev({ text: "Trợ lý trả lời tiếp!" }) })).act).toBe("resume");
  });

  it("nhóm: chỉ khi được tag hoặc reply tin trợ lý; ảnh trong nhóm thì im", () => {
    const g = { thread_id: "9", thread_type: "group" as const, assigned_profile_id: null, assigned_off: 0, handoff_until: 0 };
    const gev = (o: Partial<InboundEvent>) => ev({ threadId: "9", threadType: "group", senderId: "u5", ...o });
    expect(decide(base({ conv: g, event: gev({}) }))).toMatchObject({ act: "skip", reason: expect.stringMatching(/không ai gọi/) });
    expect(decide(base({ conv: g, event: gev({ mentions: [OWN] }) })).act).toBe("reply");
    expect(decide(base({ conv: g, event: gev({ quoteOwnerId: OWN }) })).act).toBe("reply");
    expect(decide(base({ conv: g, event: gev({ mentions: [OWN], isText: false, text: null }) })).act).toBe("skip");
    expect(decide(base({ conv: g, event: gev({ text: "@Thảo\nTrợ lý dừng lại" }) })).act).toBe("group_stop");
  });

  it("chuyển người thật theo chủ đề, có và không dấu; ảnh trong chat riêng cũng chuyển", () => {
    expect(decide(base({ event: ev({ text: "Chị chuyển khoản rồi nhé em" }) }))).toMatchObject({ act: "handoff", reason: "Liên quan tiền đã chuyển" });
    expect(decide(base({ event: ev({ text: "toi muon khieu nai" }) }))).toMatchObject({ act: "handoff", reason: "Khiếu nại / đòi tiền" });
    expect(decide(base({ event: ev({ isText: false, text: null }) }))).toMatchObject({ act: "handoff" });
    expect(handoffTopic("Cho xin số tài khoản")).toBe("Thông tin tài chính");
    expect(handoffTopic("Lịch học tuần sau thế nào?")).toBeNull();
    expect(fold("Đã Thanh  TOÁN")).toBe("da thanh toan");
  });

  it("khách xin dừng nhắn (đúng cả câu)", () => {
    expect(decide(base({ event: ev({ text: "Dừng nhắn." }) })).act).toBe("opt_out");
    expect(decide(base({ event: ev({ text: "Em dừng nhắn cho anh lúc 10h nhé" }) })).act).toBe("reply");
  });

  it("đọc dấu im lặng / chuyển người trong câu AI trả", () => {
    expect(parseReply("[[IM_LANG]]")).toEqual({ text: "", silent: true, handoff: false });
    expect(parseReply("Dạ, em chuyển chị Thảo nhé. [[CHUYEN_NGUOI]]")).toEqual({ text: "Dạ, em chuyển chị Thảo nhé.", silent: false, handoff: true });
    expect(parseReply("**Dạ** giá là 1tr")).toMatchObject({ text: "Dạ giá là 1tr" });
  });
});

function setup(opts: { reply?: string | Error; sendMode?: "draft" | "auto"; connected?: boolean } = {}) {
  const db = openDb(":memory:");
  const inbox = new Inbox(db, 1);
  const profiles = new ProfileStore(db);
  const store = new AssistantStore(db);
  profiles.update(1, { name: "CSKH", tag: "Bot CSKH", identity: { voice: "Xưng em, gọi anh/chị." }, sendMode: opts.sendMode ?? "auto", applies: "both", priority: 1 });
  const sent: { thread: string; text: string }[] = [];
  const calls: GenerateRequest[] = [];
  const labelWrites: { thread: string; target: string | null }[] = [];
  let labels: unknown[] | null = [{ text: "Bot CSKH", conversations: ["u1", "g9"] }];
  const acc: ReplierAccount = {
    accountId: 1,
    inbox,
    ownId: () => OWN,
    ownerName: () => "chị Thảo",
    isConnected: () => opts.connected ?? true,
    labels: async () => labels,
    groupName: async () => "Nhóm học viên",
    sendText: async (thread, _t, text) => {
      sent.push({ thread, text });
      return [`s${sent.length}`];
    },
    setLabel: async (thread, _t, target) => {
      labelWrites.push({ thread, target });
    },
  };
  const engine: Engine = {
    kind: "codex",
    generate: async (req) => {
      calls.push(req);
      if (opts.reply instanceof Error) throw opts.reply;
      return opts.reply ?? "Dạ khoá học là 1.999.000đ ạ.";
    },
  };
  const replier = new Replier(profiles, store, () => acc, () => engine, { batchMs: 0, now: () => NOW });
  const receive = async (e: InboundEvent) => {
    inbox.recordInbound(e, { conversationName: e.displayName });
    await replier.process(1, e);
  };
  return { db, inbox, store, replier, sent, calls, labelWrites, receive, setLabels: (l: unknown[] | null) => (labels = l) };
}

describe("luồng trả lời", () => {
  it("tự gửi: gọi AI với khung + tính cách + lịch sử, gửi và ghi là tin của trợ lý", async () => {
    const t = setup();
    await t.receive(ev());
    expect(t.sent).toEqual([{ thread: "u1", text: "Dạ khoá học là 1.999.000đ ạ." }]);
    expect(t.calls[0].system).toContain('vai trò "CSKH"');
    expect(t.calls[0].system).toContain("Xưng em, gọi anh/chị.");
    expect(t.calls[0].system).toContain("chị Thảo");
    expect(t.calls[0].messages.at(-1)).toEqual({ role: "user", content: "Khoá học bao nhiêu tiền?" });
    expect(t.inbox.messages("u1").at(-1)).toMatchObject({ direction: "out", source: "ai" });
  });

  it("soạn nháp: không gửi, tạo nháp; chủ duyệt (có sửa) thì gửi", async () => {
    const t = setup({ sendMode: "draft" });
    await t.receive(ev());
    expect(t.sent).toHaveLength(0);
    const [d] = t.store.pending(1, "u1");
    expect(d.text).toBe("Dạ khoá học là 1.999.000đ ạ.");
    await t.replier.sendDraft(d.id, "Dạ khoá học hiện là 1.999.000đ ạ, anh cần em gửi lịch học không?");
    expect(t.sent[0].text).toMatch(/gửi lịch học/);
    expect(t.store.draft(d.id)?.status).toBe("sent");
  });

  it("AI chọn im lặng thì không gửi gì", async () => {
    const t = setup({ reply: "[[IM_LANG]]" });
    await t.receive(ev({ text: "ok cảm ơn em" }));
    expect(t.sent).toHaveLength(0);
    expect(t.store.pending(1)).toHaveLength(0);
  });

  it("AI báo chuyển người: gửi lời báo, dừng hội thoại 24h, báo chủ; tin sau không gọi AI", async () => {
    const t = setup({ reply: "Dạ em chuyển chị Thảo trao đổi trực tiếp ạ. [[CHUYEN_NGUOI]]" });
    await t.receive(ev({ text: "Anh muốn mua 5 suất cho công ty" }));
    expect(t.sent[0].text).toBe("Dạ em chuyển chị Thảo trao đổi trực tiếp ạ.");
    expect(t.inbox.conversation("u1")!.handoff_until).toBeGreaterThan(NOW);
    expect(t.store.notices(1)[0]).toMatchObject({ kind: "handoff", threadId: "u1" });
    await t.receive(ev({ text: "Em ơi?" }));
    expect(t.calls).toHaveLength(1);
  });

  it("chủ đề nhạy cảm: không gọi AI, không gửi, chỉ báo chủ", async () => {
    const t = setup();
    await t.receive(ev({ text: "Chị chuyển khoản rồi nhé" }));
    expect(t.calls).toHaveLength(0);
    expect(t.sent).toHaveLength(0);
    expect(t.store.notices(1)[0].text).toMatch(/Liên quan tiền đã chuyển/);
  });

  it("chủ nhắn tay thì nháp đang chờ bị thay và AI nhường 30 phút", async () => {
    const t = setup({ sendMode: "draft" });
    await t.receive(ev());
    expect(t.store.pending(1)).toHaveLength(1);
    const own = ev({ isSelf: true, senderId: OWN, text: "Dạ chị chờ em chút", receivedAt: NOW - 500 });
    t.inbox.recordInbound(own);
    t.replier.onInbound(1, own, false);
    expect(t.store.pending(1)).toHaveLength(0);
    await t.receive(ev({ text: "Còn chỗ không em?" }));
    expect(t.calls).toHaveLength(1);
  });

  it("AI lỗi: không gửi gì, báo chủ", async () => {
    const t = setup({ reply: new Error("hết hạn mức") });
    await t.receive(ev());
    expect(t.sent).toHaveLength(0);
    expect(t.store.notices(1)[0]).toMatchObject({ kind: "error", text: expect.stringMatching(/hết hạn mức/) });
  });

  it("Zalo mất kết nối khi tự gửi: giữ thành nháp", async () => {
    const t = setup({ connected: false });
    await t.receive(ev());
    expect(t.sent).toHaveLength(0);
    expect(t.store.pending(1)).toHaveLength(1);
  });

  it("nhóm: lời chuyển người không viết vào nhóm", async () => {
    const t = setup({ reply: "Dạ em chuyển chị Thảo ạ [[CHUYEN_NGUOI]]" });
    await t.receive(ev({ threadId: "g9", threadType: "group", senderId: "u5", displayName: "Minh", mentions: [OWN], text: "@Thảo cho anh mua sỉ" }));
    expect(t.sent).toHaveLength(0);
    expect(t.inbox.conversation("g9")!.handoff_until).toBeGreaterThan(NOW);
  });

  it("nhóm nói 'trợ lý dừng lại' → gắn nhãn Không bot thật trong Zalo", async () => {
    const t = setup();
    await t.receive(ev({ threadId: "g9", threadType: "group", senderId: "u5", displayName: "Minh", text: "Trợ lý dừng lại" }));
    expect(t.labelWrites).toEqual([{ thread: "g9", target: "Không bot" }]);
    expect(t.calls).toHaveLength(0);
  });

  it("lệnh trong My Documents tạm dừng / chạy lại", async () => {
    const t = setup();
    const cmd = (text: string) => t.replier.onInbound(1, ev({ threadId: OWN, senderId: OWN, isSelf: true, text }), false);
    cmd("Tạm dừng trợ lý");
    expect(t.store.isPaused(1)).toBe(true);
    await t.receive(ev());
    expect(t.calls).toHaveLength(0);
    cmd("trợ lý chạy lại");
    expect(t.store.isPaused(1)).toBe(false);
  });
});
