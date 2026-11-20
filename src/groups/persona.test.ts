import { describe, expect, it } from "vitest";
import { openDb } from "../server/db.js";
import { Inbox } from "../channels/zalo/inbox.js";
import type { InboundEvent } from "../channels/zalo/protocol.js";
import type { Engine } from "../engines/index.js";
import { AssistantStore } from "../core/assistantStore.js";
import { ProfileStore } from "../core/profiles.js";
import { Replier, type ReplierAccount } from "../core/replier.js";
import { GroupTracker } from "./tracker.js";

const NOW = Date.UTC(2026, 10, 18, 5, 0, 0);

function setup() {
  const db = openDb(":memory:");
  const inbox = new Inbox(db, 1);
  const profiles = new ProfileStore(db);
  const store = new AssistantStore(db);
  profiles.update(1, { name: "Chăm sóc khách hàng", tag: "Bot CSKH", identity: {}, sendMode: "draft", applies: "both", priority: 1 });
  const groups = new GroupTracker(db, { channel: () => undefined, accountIds: () => [1], isPaused: () => false, mediaPath: () => null });
  // Nhóm WORKSHOP đang theo dõi, khách "k1" là thành viên còn trong nhóm, "k2" đã rời.
  db.prepare("INSERT INTO tracked_groups (account_id, group_id, name, member_count, tracked_at, reconciled_at, welcome) VALUES (1, 'g1', 'WORKSHOP 2027', 2, 0, 0, '{}')").run();
  const member = db.prepare("INSERT INTO group_members (account_id, group_id, user_id, name, present, first_seen_at, joined_at, left_at) VALUES (1, 'g1', ?, ?, ?, 0, ?, NULL)");
  member.run("k1", "Long Duy Chi", 1, NOW - 3_600_000);
  member.run("k2", "Người đã rời", 0, NOW - 3_600_000);
  let labels: { text: string; conversations: string[] }[] = [{ text: "Bot CSKH", conversations: [] }, { text: "Không bot", conversations: [] }];
  const labelWrites: { thread: string; target: string | null }[] = [];
  const acc: ReplierAccount = {
    accountId: 1,
    inbox,
    ownId: () => "me",
    ownerName: () => "chị Thảo",
    isConnected: () => true,
    labels: async () => labels.map((l) => ({ ...l, conversations: [...l.conversations] })),
    groupName: async () => "",
    sendText: async () => ["s1"],
    setLabel: async (thread, _t, target) => {
      labelWrites.push({ thread, target });
      for (const l of labels) l.conversations = l.conversations.filter((c) => c !== thread);
      if (target) labels.find((l) => l.text === target)?.conversations.push(thread);
    },
    salutation: () => "anh",
  };
  const engine: Engine = { kind: "codex", generate: async () => "Dạ em chào anh ạ." };
  const replier = new Replier(profiles, store, () => acc, () => engine, { batchMs: 0, now: () => NOW });
  replier.groupPersona = {
    find: (a, u) => groups.personaForMember(a, u),
    applied: (a, u, hit) => groups.markPersonaApplied(a, u, hit, NOW),
  };
  const receive = async (thread: string, text = "Em ơi cho anh hỏi") => {
    const e: InboundEvent = {
      threadId: thread, threadType: "user", senderId: thread, displayName: "Khách", messageId: `m${Math.random()}`,
      text, isText: true, isSelf: false, mentions: [], msgType: "webchat", receivedAt: NOW - 1000,
    };
    inbox.recordInbound(e, { conversationName: "Khách" });
    await replier.process(1, e);
  };
  const unlabel = (thread: string) => {
    for (const l of labels) l.conversations = l.conversations.filter((c) => c !== thread);
  };
  return { db, groups, store, labelWrites, receive, unlabel, setLabels: (l: typeof labels) => (labels = l) };
}

describe("tính cách theo nhóm Zalo", () => {
  it("chưa chọn tính cách cho nhóm → không gắn gì, trợ lý im như cũ", async () => {
    const t = setup();
    await t.receive("k1");
    expect(t.labelWrites).toHaveLength(0);
    expect(t.store.pending(1, "k1")).toHaveLength(0);
  });

  it("thành viên nhóm nhắn riêng → gắn nhãn tính cách của nhóm rồi trợ lý soạn trả lời luôn", async () => {
    const t = setup();
    t.groups.setPersona(1, "g1", 1);
    await t.receive("k1");
    expect(t.labelWrites).toEqual([{ thread: "k1", target: "Bot CSKH" }]);
    expect(t.store.pending(1, "k1")).toHaveLength(1);
    expect(t.store.notices(1)[0]!.text).toContain('thành viên nhóm "WORKSHOP 2027"');
    expect(t.groups.personaAppliedCount(1, "g1")).toBe(1);
  });

  it("không gắn cho người đã rời nhóm, người đã có nhãn (kể cả Không bot); chủ gỡ nhãn rồi thì không gắn lại", async () => {
    const t = setup();
    t.groups.setPersona(1, "g1", 1);
    await t.receive("k2");
    expect(t.labelWrites).toHaveLength(0);

    t.setLabels([{ text: "Bot CSKH", conversations: [] }, { text: "Không bot", conversations: ["k1"] }]);
    await t.receive("k1");
    expect(t.labelWrites).toHaveLength(0);

    t.setLabels([{ text: "Bot CSKH", conversations: [] }, { text: "Không bot", conversations: [] }]);
    await t.receive("k1", "Alo em");
    expect(t.labelWrites).toHaveLength(1);
    t.unlabel("k1"); // chủ gỡ nhãn trên điện thoại
    await t.receive("k1", "Em ơi");
    expect(t.labelWrites).toHaveLength(1);
  });
});
