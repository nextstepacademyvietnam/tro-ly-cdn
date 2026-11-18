import { describe, expect, it } from "vitest";
import { openDb } from "../server/db.js";
import { Inbox } from "../channels/zalo/inbox.js";
import type { InboundEvent } from "../channels/zalo/protocol.js";
import type { Engine } from "../engines/index.js";
import { AssistantStore } from "../core/assistantStore.js";
import { ProfileStore } from "../core/profiles.js";
import { AUTO_CAP_HOUR, Replier, type ReplierAccount } from "../core/replier.js";
import { OwnerAlerts } from "../server/ownerAlerts.js";

// 18/11/2026 10:00 giờ VN
const NOW = Date.UTC(2026, 10, 18, 3, 0, 0);
const MIN = 60_000;

function setup(sendMode: "draft" | "auto" = "auto", reply = "Dạ em chào anh ạ.") {
  const db = openDb(":memory:");
  const inbox = new Inbox(db, 1);
  const profiles = new ProfileStore(db);
  const store = new AssistantStore(db);
  profiles.update(1, { name: "CSKH", tag: "Bot CSKH", identity: {}, sendMode, applies: "both", priority: 1 });
  const sent: { thread: string; text: string }[] = [];
  let now = NOW;
  const acc: ReplierAccount = {
    accountId: 1,
    inbox,
    ownId: () => "me",
    ownerName: () => "chị Thảo",
    isConnected: () => true,
    labels: async () => [{ text: "Bot CSKH", conversations: ["k1"] }],
    groupName: async () => "",
    sendText: async (thread, _t, text) => (sent.push({ thread, text }), [`s${sent.length}`]),
    setLabel: async () => undefined,
    salutation: () => "anh",
  };
  const systems: string[] = [];
  const engine: Engine = { kind: "codex", generate: async (r) => (systems.push(r.system ?? ""), reply) };
  const replier = new Replier(profiles, store, () => acc, () => engine, { batchMs: 0, now: () => now });
  let n = 0;
  const receive = async (text: string, at = now - 1000) => {
    const e: InboundEvent = {
      threadId: "k1", threadType: "user", senderId: "k1", displayName: "Khách", messageId: `m${n++}`,
      text, isText: true, isSelf: false, mentions: [], msgType: "webchat", receivedAt: at,
    };
    inbox.recordInbound(e, { conversationName: "Anh Long" });
    await replier.process(1, e);
  };
  const alerts = new OwnerAlerts({ db, assistant: store, accountIds: () => [1], account: () => acc, now: () => now });
  return { db, inbox, store, replier, acc, sent, systems, receive, alerts, setNow: (t: number) => (now = t) };
}

describe("trả lời nhớ hồ sơ khách", () => {
  it("chat riêng có hồ sơ chăm sóc → hồ sơ nằm trong lời dặn AI", async () => {
    const t = setup("draft");
    t.replier.customerNote = (_a, thread) => (thread === "k1" ? "Giai đoạn: đang cân nhắc\nThông tin khách:\n- chủ 3 spa" : "");
    await t.receive("Em ơi");
    expect(t.systems[0]).toContain("# Điều đã biết về khách này");
    expect(t.systems[0]).toContain("chủ 3 spa");
  });
  it("chưa có hồ sơ thì không thêm khối", async () => {
    const t = setup("draft");
    t.replier.customerNote = () => "";
    await t.receive("Em ơi");
    expect(t.systems[0]).not.toContain("Điều đã biết về khách");
  });
});

describe("trần tự gửi (chặn hai bot nhắn qua lại)", () => {
  it("dưới trần thì tự gửi; chạm trần 1 giờ thì giữ nháp và báo chủ một lần", async () => {
    const t = setup("auto");
    await t.receive("Chào em");
    expect(t.sent).toHaveLength(1);
    for (let i = 0; i < AUTO_CAP_HOUR; i++) t.inbox.recordOutbound("k1", "user", `tin ${i}`, "ai", `x${i}`, NOW - (i + 2) * MIN);
    t.setNow(NOW + 5 * MIN);
    await t.receive("Alo");
    await t.receive("Alo alo");
    expect(t.sent).toHaveLength(1);
    expect(t.store.pending(1, "k1")).toHaveLength(1);
    expect(t.store.notices(1).filter((x) => x.text.includes("tự gửi"))).toHaveLength(1);
  });
});

describe("báo chủ qua Zalo", () => {
  it("khách cần người thật → gom 1 phút rồi gửi vào Cloud của tôi", async () => {
    const t = setup("draft", "Dạ em chuyển chị Thảo ạ [[CHUYEN_NGUOI]]");
    t.replier.alertOwner = (id, text) => t.alerts.alert(id, text);
    await t.receive("Anh muốn mua 10 suất");
    await t.alerts.tick();
    expect(t.sent).toHaveLength(0);
    t.setNow(NOW + 61_000);
    await t.alerts.tick();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.thread).toBe("me");
    expect(t.sent[0]!.text).toContain("Anh Long cần người thật");
  });

  it("nháp chờ quá 15 phút nhắc một lần; giờ yên lặng thì giữ tới sáng; tắt thì không gửi", async () => {
    const t = setup("draft");
    await t.receive("Giá bao nhiêu em?");
    t.setNow(NOW + 16 * MIN);
    await t.alerts.tick(); // xếp hàng
    t.setNow(NOW + 18 * MIN);
    await t.alerts.tick();
    await t.alerts.tick();
    expect(t.sent.map((s) => s.text).join()).toContain("quá 15 phút: Anh Long");
    expect(t.sent).toHaveLength(1);

    t.alerts.alert(1, "Việc ban đêm");
    t.setNow(Date.UTC(2026, 10, 18, 16, 0, 0)); // 23:00 VN
    await t.alerts.tick();
    expect(t.sent).toHaveLength(1);
    t.setNow(Date.UTC(2026, 10, 19, 1, 0, 0)); // 08:00 VN hôm sau
    await t.alerts.tick();
    expect(t.sent[1]!.text).toContain("Việc ban đêm");

    t.alerts.setEnabled(1, false);
    t.alerts.alert(1, "Không được gửi");
    t.setNow(Date.UTC(2026, 10, 19, 2, 0, 0));
    await t.alerts.tick();
    expect(t.sent).toHaveLength(2);
  });

  it("tóm tắt cuối ngày lúc 17:30, mỗi ngày một lần", async () => {
    const t = setup("draft");
    await t.receive("Cho anh hỏi khoá học");
    t.setNow(Date.UTC(2026, 10, 18, 10, 0, 0)); // 17:00 VN: chưa tới giờ
    await t.alerts.tick();
    const before = t.sent.length;
    t.setNow(Date.UTC(2026, 10, 18, 10, 31, 0)); // 17:31 VN
    await t.alerts.tick();
    await t.alerts.tick();
    const digests = t.sent.slice(before).filter((s) => s.text.includes("tóm tắt hôm nay"));
    expect(digests).toHaveLength(1);
    expect(digests[0]!.text).toContain("1 tin từ 1 người nhắn riêng");
    expect(digests[0]!.text).toContain("1 nháp đang chờ bạn duyệt");
  });
});
