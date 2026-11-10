import { describe, expect, it } from "vitest";
import { EMPTY_IDENTITY, activeNotes, composeProfilePrompt, identityToText, textToIdentity } from "./promptLayers.js";
import { AssistantStore } from "./assistantStore.js";
import { checkLayerReminders } from "./layerReminder.js";
import { openDb } from "../server/db.js";
import { Inbox } from "../channels/zalo/inbox.js";
import { parseOptimizerReply } from "../server/routes/profiles.js";
import { ProfileStore, resolveProfile, type Profile } from "./profiles.js";

const mk = (over: Partial<Profile>): Profile => ({
  id: 1, accountId: 1, name: "CSKH", tag: "Bot CSKH", identity: EMPTY_IDENTITY, sendMode: "draft", applies: "both", priority: 100, updatedAt: 0, ...over,
});
type Conv = { thread_id: string; thread_type: "user" | "group"; assigned_profile_id: number | null; assigned_off: number };
const conv = (over: Partial<Conv> = {}): Conv => ({ thread_id: "u1", thread_type: "user", assigned_profile_id: null, assigned_off: 0, ...over });

describe("chọn tính cách cho hội thoại", () => {
  const cskh = mk({ id: 1, name: "CSKH", tag: "Bot CSKH", priority: 1 });
  const work = mk({ id: 2, name: "Công việc", tag: "Bot Công việc", priority: 2, applies: "group" });
  const profiles = [cskh, work];

  it("không nhãn → không trả lời; không đọc được nhãn → cũng không", () => {
    expect(resolveProfile(conv(), profiles, [], "Không bot")).toEqual({ kind: "none" });
    expect(resolveProfile(conv(), profiles, null, "Không bot")).toEqual({ kind: "none" });
  });

  it("nhãn Zalo chọn tính cách; nhiều nhãn thì ưu tiên số nhỏ và báo xung đột", () => {
    const labels = [
      { text: "Bot CSKH", conversations: ["g9"] },
      { text: "Bot Công việc", conversations: ["g9"] },
    ];
    const r = resolveProfile(conv({ thread_id: "9", thread_type: "group" }), profiles, labels, "Không bot");
    expect(r).toMatchObject({ kind: "profile", source: "zalo", profile: { id: 1 } });
    expect(r.kind === "profile" && r.conflict.map((p) => p.id)).toEqual([2]);
  });

  it("tính cách chỉ cho nhóm thì không áp vào chat riêng", () => {
    const labels = [{ text: "Bot Công việc", conversations: ["u1"] }];
    expect(resolveProfile(conv(), profiles, labels, "Không bot")).toEqual({ kind: "none" });
  });

  it("nhãn Không bot thắng nhãn khác; gắn trên web thắng nhãn Zalo", () => {
    const labels = [
      { text: "Bot CSKH", conversations: ["u1"] },
      { text: "không bot", conversations: ["u1"] },
    ];
    expect(resolveProfile(conv(), profiles, labels, "Không bot")).toEqual({ kind: "off", source: "zalo" });
    expect(resolveProfile(conv({ assigned_profile_id: 2 }), profiles, labels, "Không bot")).toMatchObject({
      kind: "profile",
      source: "web",
      profile: { id: 2 },
    });
    expect(resolveProfile(conv({ assigned_off: 1 }), profiles, [{ text: "Bot CSKH", conversations: ["u1"] }], "Không bot")).toEqual({
      kind: "off",
      source: "web",
    });
  });

  it("gắn hàng loạt trên web; xoá tính cách thì bỏ gắn", () => {
    const db = openDb(":memory:");
    const inbox = new Inbox(db, 1);
    for (const id of ["a", "b"]) {
      inbox.recordInbound({ threadId: id, threadType: "user", senderId: id, displayName: id, messageId: id, text: "hi", isText: true, isSelf: false, mentions: [], msgType: "", receivedAt: 1 });
    }
    const store = new ProfileStore(db);
    const p = store.create(1, { name: "Tạm", tag: "", identity: {}, sendMode: "draft", applies: "both", priority: 5 });
    inbox.assign(["a", "b"], p.id);
    expect(inbox.conversation("a")?.assigned_profile_id).toBe(p.id);
    inbox.assign(["b"], "off");
    expect(inbox.conversation("b")).toMatchObject({ assigned_profile_id: null, assigned_off: 1 });
    store.remove(p.id);
    expect(inbox.conversation("a")?.assigned_profile_id).toBeNull();
  });
});

describe("AI tối ưu hướng dẫn theo tầng", () => {
  it("tách đề xuất tầng 1 (theo ô), ghi chú tầng 3, hỏi đáp tầng 2 khỏi lời chat", () => {
    const r = parseOptimizerReply(
      [
        "Mình đã sửa:",
        "- Thêm xưng hô",
        "<huong_dan_moi>",
        "### Trợ lý là ai, thay mặt ai",
        "Bạn là Mai.",
        "### Giọng và xưng hô",
        "Xưng em.",
        "### Mục lạ",
        "Dặn thêm",
        "</huong_dan_moi>",
        '<thoi_diem han="2026-11-30">Giảm 20% khoá K13</thoi_diem>',
        "<hoi_dap><hoi>Học online không?</hoi><dap>Dạ học qua Zoom ạ.</dap></hoi_dap>",
        "Bạn xem thử nhé.",
      ].join("\n"),
    );
    expect(r.proposal).toMatchObject({ who: "Bạn là Mai.", voice: "Xưng em.", notes: "Mục lạ\nDặn thêm" });
    expect(r.notes).toEqual([{ text: "Giảm 20% khoá K13", expiresOn: "2026-11-30" }]);
    expect(r.faqs).toEqual([{ question: "Học online không?", answer: "Dạ học qua Zoom ạ." }]);
    expect(r.message).toBe("Mình đã sửa:\n- Thêm xưng hô\n\nBạn xem thử nhé.");
    expect(parseOptimizerReply("Bạn muốn trợ lý xưng hô thế nào?")).toEqual({
      message: "Bạn muốn trợ lý xưng hô thế nào?",
      proposal: null,
      notes: [],
      faqs: [],
    });
  });
});

describe("ghép hướng dẫn 4 tầng", () => {
  const NOW = Date.UTC(2026, 10, 10, 3, 0); // 10h sáng thứ Ba 10/11/2026 giờ VN

  it("thứ tự ít đổi → hay đổi, có ngày hôm nay, bỏ ghi chú hết hạn, bỏ ô trống", () => {
    const text = composeProfilePrompt({
      name: "CSKH",
      identity: { ...EMPTY_IDENTITY, who: "Bạn là Mai.", voice: "Xưng em." },
      docs: [{ name: "bang-gia.txt", text: "Khoá A 1tr" }],
      faqs: [{ question: "Học ở đâu?", answer: "Online." }],
      notes: [
        { text: "Giảm 20%", expiresOn: "2026-11-10" },
        { text: "Hết đợt cũ", expiresOn: "2026-11-09" },
        { text: "Nghỉ thứ Bảy", expiresOn: null },
      ],
      now: NOW,
    });
    const i1 = text.indexOf("Tầng 1"), i2 = text.indexOf("Tầng 2"), i3 = text.indexOf("Tầng 3");
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i3);
    expect(text).toContain("Hôm nay là Thứ Ba, 10/11/2026.");
    expect(text).toContain("- Giảm 20% (hiệu lực đến hết 10/11/2026)");
    expect(text).toContain("- Nghỉ thứ Bảy");
    expect(text).not.toContain("Hết đợt cũ");
    expect(text).toContain("## Giọng và xưng hô\nXưng em.");
    expect(text).not.toContain("## Mục tiêu");
    expect(text).toContain("Hỏi: Học ở đâu?\nĐáp: Online.");
    expect(activeNotes([{ text: "x", expiresOn: "2026-11-09" }], NOW)).toHaveLength(0);
  });

  it("tầng 1 viết ra văn bản rồi đọc lại không mất ô nào", () => {
    const id = { ...EMPTY_IDENTITY, who: "A", goal: "B", can: "- c1\n- c2", notes: "N" };
    expect(textToIdentity(identityToText(id))).toEqual(id);
    expect(textToIdentity("Chỉ một khối chữ")).toMatchObject({ notes: "Chỉ một khối chữ" });
  });

  it("nhắc ghi chú sắp hết hạn một lần, nhắc tầng 3 cũ tối đa mỗi tuần", () => {
    const db = openDb(":memory:");
    const store = new ProfileStore(db);
    const assistant = new AssistantStore(db);
    store.saveNote(1, { text: "Giảm 20%", expiresOn: "2026-11-11" });
    db.prepare("UPDATE profile_notes SET updated_at = ?").run(NOW - 10 * 86_400_000);
    db.prepare("UPDATE profiles SET created_at = ?").run(NOW - 30 * 86_400_000);
    expect(checkLayerReminders(db, assistant, NOW)).toBe(2); // sắp hết hạn + 10 ngày chưa cập nhật
    expect(checkLayerReminders(db, assistant, NOW + 3_600_000)).toBe(0);
    expect(assistant.notices(1).map((n) => n.text).join(" | ")).toMatch(/hết hạn ngày 11\/11\/2026.*\| .*10 ngày chưa cập nhật|10 ngày chưa cập nhật.*\| .*hết hạn ngày 11\/11\/2026/);
  });
});
