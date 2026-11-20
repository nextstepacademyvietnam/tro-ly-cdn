import { describe, expect, it } from "vitest";
import { openDb } from "../server/db.js";
import { Inbox } from "../channels/zalo/inbox.js";
import type { InboundEvent } from "../channels/zalo/protocol.js";
import type { Engine } from "../engines/index.js";
import { AssistantStore } from "../core/assistantStore.js";
import { ProfileStore } from "../core/profiles.js";
import { Replier, type ReplierAccount } from "../core/replier.js";
import { isClosingMessage, WAIT_LOOKBACK_MS, WAIT_REPLY_MS } from "../core/waiting.js";
import { ConnectionWatch, DOWN_ALERT_MS } from "../server/connectionWatch.js";
import { parseLearned, parseTriage } from "./prompt.js";
import { AssistService } from "./service.js";

const NOW = Date.UTC(2026, 10, 18, 5, 0, 0);
const MIN = 60_000;

function setup(reply = "Dạ em chào anh ạ.") {
  const db = openDb(":memory:");
  const inbox = new Inbox(db, 1);
  const profiles = new ProfileStore(db);
  const store = new AssistantStore(db);
  profiles.update(1, { name: "Chăm sóc khách hàng", tag: "Bot CSKH", identity: { who: "Trợ lý của Next Step Group" }, sendMode: "draft", applies: "both", priority: 1 });
  const labels: { text: string; conversations: string[] }[] = [
    { text: "Bot CSKH", conversations: [] },
    { text: "Không bot", conversations: [] },
  ];
  const acc: ReplierAccount = {
    accountId: 1,
    inbox,
    ownId: () => "me",
    ownerName: () => "chị Thảo",
    isConnected: () => true,
    labels: async () => labels,
    groupName: async () => "",
    sendText: async () => ["s1"],
    setLabel: async () => undefined,
    salutation: () => "anh",
  };
  const calls: { system: string; content: string }[] = [];
  let answer = reply;
  const engine: Engine = {
    kind: "codex",
    generate: async (r) => {
      calls.push({ system: r.system ?? "", content: r.messages.map((m) => m.content).join("\n") });
      return answer;
    },
  };
  const replier = new Replier(profiles, store, () => acc, () => engine, { batchMs: 0, now: () => NOW });
  const assist = new AssistService({ db, assistant: store, profiles, account: () => acc, accountIds: () => [1], engine: () => engine, now: () => NOW });
  let n = 0;
  const msg = (thread: string, text: string | null, at: number, opts: { self?: boolean; kind?: string; name?: string } = {}) => {
    const e: InboundEvent = {
      threadId: thread, threadType: "user", senderId: opts.self ? "me" : thread, displayName: opts.name ?? "Khách", messageId: `m${n++}`,
      text: text ?? "", isText: text !== null, isSelf: Boolean(opts.self), mentions: [], msgType: opts.kind ?? "webchat", receivedAt: at,
    };
    inbox.recordInbound(e, { conversationName: opts.name ?? `Khách ${thread}` });
  };
  return { db, inbox, profiles, store, replier, assist, labels, msg, calls, setAnswer: (t: string) => (answer = t) };
}

describe("tin khép chuyện (không cần trả lời)", () => {
  it.each([
    ["ok", true], ["Okeee ạ", true], ["Dạ vâng ạ", true], ["cảm ơn em nhiều nha", true], ["👍", true], ["Ok cảm ơn", true],
    ["Bao nhiêu tiền vậy em?", false], ["ok, vậy lịch học thế nào", false], ["Cho anh xin link đăng ký", false],
  ])("%s → %s", (text, closing) => {
    expect(isClosingMessage(text, "webchat")).toBe(closing);
  });
  it("nhãn dán là khép chuyện, ảnh thì không", () => {
    expect(isClosingMessage(null, "chat.sticker")).toBe(true);
    expect(isClosingMessage(null, "chat.photo")).toBe(false);
  });
});

describe("khách chờ lâu", () => {
  const waiting = (t: ReturnType<typeof setup>) => t.inbox.waitingReplies(NOW, WAIT_REPLY_MS, WAIT_LOOKBACK_MS);

  it("khách nhắn quá 30 phút chưa ai trả lời → chờ, tính từ tin đầu chưa được trả lời", () => {
    const t = setup();
    t.msg("k1", "Chào em", NOW - 3 * 60 * MIN);
    t.msg("k1", "Dạ chị chào anh", NOW - 170 * MIN, { self: true });
    t.msg("k1", "Khoá học bao nhiêu tiền em?", NOW - 60 * MIN);
    t.msg("k1", "Có học online không", NOW - 50 * MIN);
    t.msg("k2", "Em ơi", NOW - 10 * MIN); // chưa đủ 30 phút
    expect([...waiting(t)]).toEqual([["k1", NOW - 60 * MIN]]);
  });

  it("chủ trả lời, khách gửi nhãn dán / 'ok', tin quá 7 ngày, chủ bấm Không cần trả lời → không chờ", () => {
    const t = setup();
    t.msg("a", "Hỏi chút", NOW - 60 * MIN);
    t.msg("a", "Dạ anh hỏi gì ạ", NOW - 59 * MIN, { self: true });
    t.msg("b", "Cảm ơn em", NOW - 60 * MIN);
    t.msg("c", null, NOW - 60 * MIN, { kind: "chat.sticker" });
    t.msg("d", "Cũ lắm rồi", NOW - 8 * 24 * 60 * MIN);
    t.msg("e", "Giá sao em?", NOW - 60 * MIN);
    t.inbox.markNoReplyNeeded("e");
    expect(waiting(t).size).toBe(0);
    // Khách nhắn tiếp sau khi chủ bấm "Không cần trả lời" thì lại tính chờ.
    t.msg("e", "Em ơi trả lời anh với", NOW - 40 * MIN);
    expect([...waiting(t).keys()]).toEqual(["e"]);
  });

  it("Nhờ trợ lý soạn: soạn nháp theo tính cách chọn dù khách chưa gắn nhãn, không tự gửi", async () => {
    const t = setup("Dạ khoá học 179k anh nhé.");
    t.msg("k1", "Khoá học bao nhiêu tiền em?", NOW - 60 * MIN);
    const d = await t.replier.draftFor(1, "k1", 1);
    expect(d.text).toBe("Dạ khoá học 179k anh nhé.");
    expect(t.store.pending(1, "k1")).toHaveLength(1);
    expect(t.calls[0]!.system).toContain("Chăm sóc khách hàng");
    t.setAnswer("[[IM_LANG]]");
    await expect(t.replier.draftFor(1, "k1", 1)).rejects.toThrow(/không cần trả lời/);
  });
});

describe("học từ chủ", () => {
  it("sửa nháp rồi gửi: giữ bản AI gốc, đếm gửi nguyên văn / sửa / bỏ", () => {
    const t = setup();
    t.msg("k1", "Giá?", NOW - 10 * MIN);
    const a = t.store.addDraft(1, "k1", 1, "Dạ 199k ạ", false, NOW - 9 * MIN);
    t.store.decide(a.id, "sent", "", "Dạ 179k anh nhé", NOW);
    const b = t.store.addDraft(1, "k2", 1, "Dạ chào anh", false, NOW - 9 * MIN);
    t.store.decide(b.id, "sent", "", "Dạ chào anh", NOW);
    const c = t.store.addDraft(1, "k3", 1, "Sai", false, NOW - 9 * MIN);
    t.store.decide(c.id, "discarded", "", undefined, NOW);
    expect(t.store.draft(a.id)).toMatchObject({ text: "Dạ 179k anh nhé", originalText: "Dạ 199k ạ" });
    expect(t.store.draft(b.id)!.originalText).toBeNull();
    expect(t.store.draftStats(1, NOW - MIN)).toEqual({ sentAsIs: 1, edited: 1, discarded: 1 });
  });

  it("rút lượt khách hỏi → chủ trả lời và nháp chủ sửa; bỏ hội thoại 'Không bot' và câu trả lời quá ngắn", () => {
    const t = setup();
    t.msg("k1", "Lịch workshop tháng này thế nào em?", NOW - 100 * MIN);
    t.msg("k1", "Workshop tối thứ 5 hằng tuần, 20h trên Zoom anh nhé, link gửi trước 1 tiếng", NOW - 99 * MIN, { self: true });
    t.msg("k1", "ok", NOW - 98 * MIN);
    t.msg("k1", "Dạ vâng ạ", NOW - 97 * MIN, { self: true }); // quá ngắn
    t.msg("me", "Tối nay ăn gì", NOW - 90 * MIN, { name: "Mẹ" });
    t.msg("me", "Con về ăn cơm nhà mẹ nhé, tối nay con về muộn một chút", NOW - 89 * MIN, { self: true });
    t.labels[1]!.conversations.push("me");
    t.msg("k2", "Học phí bao nhiêu?", NOW - 80 * MIN);
    const d = t.store.addDraft(1, "k2", 1, "Dạ học phí 199k", false, NOW - 79 * MIN);
    t.store.decide(d.id, "sent", "", "Dạ học phí 179k, đóng qua link thanh toán anh nhé", NOW - 78 * MIN);
    const pairs = t.assist.learnPairs(1, t.labels, NOW - 24 * 60 * MIN);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toMatchObject({ question: "Học phí bao nhiêu?", aiDraft: "Dạ học phí 199k" });
    expect(pairs[1]).toMatchObject({ question: "Lịch workshop tháng này thế nào em?" });
  });

  it("gợi ý hỏi đáp: AI rút ra, chủ duyệt (có sửa) thì vào hỏi đáp tầng 2, bỏ thì thôi", async () => {
    const t = setup(
      "<hoi_dap><hoi>Lịch workshop?</hoi><dap>Tối thứ 5, 20h trên Zoom.</dap><vi_sao>chủ trả lời k1</vi_sao></hoi_dap>" +
        "<hoi_dap><hoi>Học phí?</hoi><dap>179k</dap></hoi_dap>",
    );
    t.msg("k1", "Lịch workshop tháng này thế nào em?", NOW - 100 * MIN);
    t.msg("k1", "Workshop tối thứ 5 hằng tuần, 20h trên Zoom anh nhé", NOW - 99 * MIN, { self: true });
    expect(await t.assist.learn(1)).toBe(2);
    const [s1, s2] = t.assist.pendingSuggestions(1);
    t.assist.decideSuggestion(1, s1!.id, true, { answer: "Tối thứ 5 hằng tuần, 20h trên Zoom." });
    t.assist.decideSuggestion(1, s2!.id, false);
    expect(t.assist.pendingSuggestions(1)).toHaveLength(0);
    expect(t.profiles.faqs(1).map((f) => f.answer)).toEqual(["Tối thứ 5 hằng tuần, 20h trên Zoom."]);
    expect(t.assist.learnedAt(1)).toBe(NOW);
  });

  it("đọc thẻ hỏi đáp, bỏ cặp thiếu", () => {
    expect(parseLearned("<khong_co/>")).toEqual([]);
    expect(parseLearned("<hoi_dap><hoi>A?</hoi></hoi_dap><hoi_dap><hoi>B?</hoi><dap>b</dap></hoi_dap>")).toEqual([{ question: "B?", answer: "b", evidence: "" }]);
  });
});

describe("gợi ý gắn nhãn", () => {
  it("đọc kết quả, mã lạ thì bỏ", () => {
    expect(parseTriage('<chon ma="1">hỏi học phí</chon>', [1])).toEqual({ kind: "pick", profileId: 1, reason: "hỏi học phí" });
    expect(parseTriage('<chon ma="9">x</chon>', [1])).toEqual({ kind: "invalid" });
    expect(parseTriage("<khong>người nhà</khong>", [1])).toEqual({ kind: "none", reason: "người nhà" });
  });

  it("chỉ xét khách chưa có nhãn, đã nhắn xong; lưu gợi ý; Bỏ qua thì không gợi ý lại", async () => {
    const t = setup('<chon ma="1">hỏi khoá học</chon>');
    t.msg("k1", "Cho em hỏi khoá học", NOW - 10 * MIN);
    t.msg("k2", "Có nhãn rồi", NOW - 10 * MIN);
    t.labels[0]!.conversations.push("k2");
    t.msg("k3", "Vừa nhắn", NOW - 30_000);
    expect(t.assist.triageCandidates(1, t.labels)).toEqual(["k1"]);
    expect(await t.assist.triage(1, "k1")).toBe(1);
    expect(t.inbox.conversation("k1")).toMatchObject({ suggest_profile_id: 1, suggest_reason: "hỏi khoá học" });
    expect(t.assist.triageCandidates(1, t.labels)).toEqual([]);
    t.assist.dismissSuggestion(1, "k1");
    expect(t.inbox.conversation("k1")).toMatchObject({ suggest_profile_id: null, suggest_dismissed: 1 });
  });
});

describe("canh kết nối Zalo", () => {
  it("rớt quá 10 phút báo một lần, nối lại thì báo đã nối lại; chủ đăng xuất thì không báo", () => {
    let now = NOW;
    let state = "reconnecting";
    const notes: string[] = [];
    const w = new ConnectionWatch(
      {
        list: () => [{ id: 1, name: "Thu Thảo", own_id: "z1" }] as never,
        get: () => ({ channel: { getStatus: () => ({ state, since: NOW }) } }) as never,
      },
      { notify: (_a, _k, text) => void notes.push(text) },
      () => now,
    );
    w.check();
    now += DOWN_ALERT_MS - MIN;
    w.check();
    expect(notes).toHaveLength(0);
    now += 2 * MIN;
    w.check();
    w.check();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("mất kết nối");
    state = "connected";
    w.check();
    expect(notes[1]).toContain("kết nối lại sau 11 phút");
    state = "logged_out";
    now += DOWN_ALERT_MS * 2;
    w.check();
    expect(notes).toHaveLength(2);
  });
});
