import { describe, expect, it } from "vitest";
import { openDb } from "../server/db.js";
import { Inbox } from "../channels/zalo/inbox.js";
import type { InboundEvent } from "../channels/zalo/protocol.js";
import type { Engine, GenerateRequest } from "../engines/index.js";
import { AssistantStore } from "../core/assistantStore.js";
import { ProfileStore } from "../core/profiles.js";
import { Replier, type ReplierAccount } from "../core/replier.js";
import { addDays, inQuietVN, parseCarePlan, slotOnDay, vnAt, vnDay } from "./prompt.js";
import { CareService } from "./service.js";
import { CareStore } from "./store.js";

/** 18/11/2026 10:00 giờ VN. */
const T0 = vnAt("2026-11-18", 10 * 60);
const H = 3_600_000;

const ANALYSIS = `<giai_doan>đang cân nhắc</giai_doan>
<ho_so>- Chủ chuỗi 3 spa ở Hà Nội
- Quan tâm khoá Sales Bứt Phá</ho_so>
<tom_tat>Chị hỏi học phí và lịch khai giảng, hẹn cuối tuần trả lời.</tom_tat>
<nhu_cau>Muốn đội sale chốt khách tốt hơn</nhu_cau>
<lich moi_ngay="2" lan_toi="2026-11-20">Khách đang cân nhắc, hẹn cuối tuần</lich>
<muc_tieu>Gửi lịch khai giảng tháng 12 và hỏi chị đã bàn với đội chưa</muc_tieu>`;

describe("phần thuần", () => {
  it("đọc kết quả phân tích", () => {
    const u = parseCarePlan(ANALYSIS, "2026-11-18");
    expect(u).toMatchObject({ stage: "đang cân nhắc", everyDays: 2, nextDay: "2026-11-20", stop: "" });
    expect(u.facts).toContain("Chủ chuỗi 3 spa");
    expect(u.reason).toBe("Khách đang cân nhắc, hẹn cuối tuần");
    // Ngày trong quá khứ / sai, tần suất ngoài khoảng.
    const bad = parseCarePlan(`<lich moi_ngay="400" lan_toi="2026-11-01">x</lich>`, "2026-11-18");
    expect(bad).toMatchObject({ everyDays: 60, nextDay: null });
    expect(parseCarePlan(`<dung_cham_soc>Khách là người nhà</dung_cham_soc>`, "2026-11-18").stop).toBe("Khách là người nhà");
    expect(parseCarePlan("xin lỗi tôi không hiểu", "2026-11-18")).toMatchObject({ summary: "", everyDays: null });
  });

  it("giờ Việt Nam: khung sáng, cộng ngày, giờ yên lặng", () => {
    const slot = slotOnDay("2026-11-20", () => 0.5);
    expect(vnDay(slot)).toBe("2026-11-20");
    expect(new Date(slot + 7 * H).getUTCHours()).toBe(9);
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(inQuietVN(vnAt("2026-11-18", 22 * 60))).toBe(true);
    expect(inQuietVN(vnAt("2026-11-18", 7 * 60))).toBe(true);
    expect(inQuietVN(vnAt("2026-11-18", 9 * 60))).toBe(false);
  });
});

function setup(opts: { careEnabled?: boolean; reply?: string; connected?: boolean } = {}) {
  const db = openDb(":memory:");
  const inbox = new Inbox(db, 1);
  const profiles = new ProfileStore(db);
  const assistant = new AssistantStore(db);
  const store = new CareStore(db);
  profiles.update(1, { name: "Chăm sóc khách hàng", tag: "Bot CSKH", identity: { voice: "Xưng em, gọi anh/chị." }, sendMode: "draft", applies: "both", priority: 1 });
  profiles.setCare(1, { enabled: opts.careEnabled ?? true, rules: "Khách đã mua: hỏi thăm sau 7 ngày.", maxPerDay: 2 });
  let now = T0;
  let labels: unknown[] | null = [{ text: "Bot CSKH", conversations: ["u1", "u2", "u3"] }];
  const calls: GenerateRequest[] = [];
  const sent: { thread: string; text: string; proactive?: boolean }[] = [];
  let reply = opts.reply ?? "";
  const acc: ReplierAccount = {
    accountId: 1,
    inbox,
    ownId: () => "me",
    ownerName: () => "chị Thảo",
    isConnected: () => opts.connected ?? true,
    labels: async () => labels,
    groupName: async () => "",
    sendText: async (thread, _t, text, o) => {
      sent.push({ thread, text, proactive: o?.proactive });
      return [`s${sent.length}`];
    },
    setLabel: async () => undefined,
    salutation: () => "chị",
  };
  const engine: Engine = {
    kind: "codex",
    generate: async (req) => {
      calls.push(req);
      return reply;
    },
  };
  const service = new CareService({ store, assistant, profiles, account: () => acc, accountIds: () => [1], engine: () => engine, now: () => now, rand: () => 0.5 });
  const replier = new Replier(profiles, assistant, () => acc, () => engine, { batchMs: 0, now: () => now, onDraftSent: (d) => service.onDraftSent(d) });
  const say = (thread: string, text: string, at: number, fromCustomer = true) => {
    const e: InboundEvent = {
      threadId: thread, threadType: "user", senderId: fromCustomer ? thread : "me", displayName: "Lan", messageId: `m${Math.random()}`,
      text, isText: true, isSelf: !fromCustomer, mentions: [], msgType: "webchat", receivedAt: at,
    };
    inbox.recordInbound(e, { conversationName: "Chị Lan" });
  };
  return {
    db, inbox, assistant, store, service, replier, calls, sent,
    setNow: (t: number) => (now = t),
    setReply: (r: string) => (reply = r),
    setLabels: (l: unknown[] | null) => (labels = l),
    say,
  };
}

describe("phân tích khách", () => {
  it("chọn hội thoại có tin mới đã yên 30 phút, lưu hồ sơ + lịch, ghi lịch sử", async () => {
    const t = setup({ reply: ANALYSIS });
    t.say("u1", "Học phí khoá Sales Bứt Phá bao nhiêu em?", T0 - 2 * H);
    t.say("u2", "Chào em", T0 - 10 * 60_000); // mới nhắn 10 phút: chưa phân tích
    expect(await t.service.findOneToAnalyze(1)).toBe("u1");
    await t.service.tick();
    const p = t.store.get(1, "u1")!;
    expect(p).toMatchObject({ status: "active", stage: "đang cân nhắc", everyDays: 2, profileId: 1 });
    expect(vnDay(p.nextAt!)).toBe("2026-11-20");
    expect(t.calls[0]!.system).toContain("Khách đã mua: hỏi thăm sau 7 ngày.");
    expect(t.calls[0]!.system).toContain("Xưng em, gọi anh/chị.");
    expect(String(t.calls[0]!.messages[0]!.content)).toContain("Học phí khoá Sales Bứt Phá");
    expect(t.store.history(1, "u1")[0]).toMatchObject({ kind: "analyze" });
    // Không có tin mới → không phân tích lại.
    expect(await t.service.findOneToAnalyze(1)).toBeNull();
  });

  it("không áp dụng khi tính cách tắt chăm sóc hoặc khách không có nhãn", async () => {
    const t = setup({ reply: ANALYSIS, careEnabled: false });
    t.say("u1", "Hỏi chút", T0 - 2 * H);
    expect(await t.service.findOneToAnalyze(1)).toBeNull();
    expect(await t.service.analyze(1, "u1")).toBeNull();
    const t2 = setup({ reply: ANALYSIS });
    t2.setLabels([{ text: "Bot CSKH", conversations: [] }]);
    t2.say("u1", "Hỏi chút", T0 - 2 * H);
    expect(await t2.service.findOneToAnalyze(1)).toBeNull();
  });

  it("kế hoạch chủ khoá: AI cập nhật hồ sơ nhưng giữ lịch; AI đề nghị dừng thì dừng", async () => {
    const t = setup({ reply: ANALYSIS });
    t.say("u1", "Hỏi chút", T0 - 2 * H);
    await t.service.analyze(1, "u1");
    const fixed = vnAt("2026-11-25", 9 * 60);
    t.store.edit(1, "u1", { everyDays: 5, nextAt: fixed, locked: true }, T0);
    t.setReply(ANALYSIS.replace('moi_ngay="2"', 'moi_ngay="1"').replace("đang cân nhắc", "sắp quyết định"));
    await t.service.analyze(1, "u1");
    expect(t.store.get(1, "u1")).toMatchObject({ everyDays: 5, nextAt: fixed, stage: "sắp quyết định", locked: true });

    const t2 = setup({ reply: "<dung_cham_soc>Người nhà, không phải khách</dung_cham_soc><tom_tat>Hỏi thăm gia đình</tom_tat>" });
    t2.say("u1", "Tối nay về ăn cơm nhé", T0 - 2 * H);
    await t2.service.analyze(1, "u1");
    expect(t2.store.get(1, "u1")).toMatchObject({ status: "stopped", nextAt: null, stopReason: "Người nhà, không phải khách" });
  });
});

describe("chạy lịch chăm sóc", () => {
  async function planned() {
    const t = setup({ reply: ANALYSIS });
    t.say("u1", "Học phí bao nhiêu em?", T0 - 2 * H);
    await t.service.analyze(1, "u1");
    t.setNow(vnAt("2026-11-20", 10 * 60));
    t.setReply("Dạ chị Lan ơi, lớp tháng 12 khai giảng ngày 5/12 ạ. Chị đã bàn với đội sale chưa ạ?");
    return t;
  }

  it("tới ngày → soạn nháp chăm sóc chờ duyệt, báo chuông, đẩy lịch một chu kỳ; duyệt thì gửi chủ động và đếm", async () => {
    const t = await planned();
    await t.service.tick();
    const drafts = t.assistant.pending(1, "u1");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ origin: "care", profileId: 1 });
    expect(t.calls.at(-1)!.system).toContain("CHỦ ĐỘNG nhắn");
    expect(String(t.calls.at(-1)!.messages[0]!.content)).toContain("Gửi lịch khai giảng tháng 12");
    expect(t.assistant.notices(1)[0]).toMatchObject({ kind: "care" });
    expect(vnDay(t.store.get(1, "u1")!.nextAt!)).toBe("2026-11-22");
    expect(t.sent).toHaveLength(0); // chưa tự gửi

    await t.replier.sendDraft(drafts[0]!.id);
    expect(t.sent[0]).toMatchObject({ thread: "u1", proactive: true });
    expect(t.store.get(1, "u1")).toMatchObject({ careCount: 1 });
    expect(t.store.history(1, "u1")[0]).toMatchObject({ kind: "sent" });
  });

  it("bỏ qua / dời: khách xin dừng, vừa nói chuyện, còn nháp chờ, nhãn gỡ, giờ yên lặng, quá giới hạn ngày", async () => {
    // Khách xin dừng → dừng hẳn.
    let t = await planned();
    t.inbox.setNoProactive("u1", true);
    await t.service.tick();
    expect(t.store.get(1, "u1")).toMatchObject({ status: "stopped", nextAt: null });

    // Khách vừa nhắn 2 giờ trước → dời sang hôm sau, không soạn.
    t = await planned();
    t.say("u1", "Em ơi", vnAt("2026-11-20", 8 * 60));
    const before = t.calls.length;
    await t.service.runPlan(t.store.get(1, "u1")!, [{ text: "Bot CSKH", conversations: ["u1"] }]);
    expect(t.calls.length).toBe(before);
    expect(vnDay(t.store.get(1, "u1")!.nextAt!)).toBe("2026-11-21");

    // Nhãn đã gỡ → tạm dừng kế hoạch.
    t = await planned();
    t.setLabels([{ text: "Bot CSKH", conversations: [] }]);
    await t.service.tick();
    expect(t.store.get(1, "u1")!.status).toBe("paused");

    // Giờ yên lặng 23:00 → dời sáng hôm sau, không soạn.
    t = await planned();
    t.setNow(vnAt("2026-11-20", 23 * 60));
    await t.service.tick();
    expect(t.assistant.pending(1, "u1")).toHaveLength(0);
    expect(vnDay(t.store.get(1, "u1")!.nextAt!)).toBe("2026-11-21");

    // Còn nháp chăm sóc chưa duyệt → không soạn thêm.
    t = await planned();
    await t.service.tick();
    t.store.reschedule(1, "u1", vnAt("2026-11-20", 9 * 60), vnAt("2026-11-20", 10 * 60));
    await t.service.tick();
    expect(t.assistant.pending(1, "u1")).toHaveLength(1);
    expect(t.store.history(1, "u1")[0]).toMatchObject({ kind: "skip", text: "Tin chăm sóc trước còn chờ duyệt" });
  });

  it("AI thấy chưa nên nhắn ([[IM_LANG]]) → dời một chu kỳ, không tạo nháp", async () => {
    const t = await planned();
    t.setReply("[[IM_LANG]]");
    await t.service.tick();
    expect(t.assistant.pending(1, "u1")).toHaveLength(0);
    expect(vnDay(t.store.get(1, "u1")!.nextAt!)).toBe("2026-11-22");
  });

  it("khách nhắn tiếp sau khi có nháp chăm sóc: lần phân tích sau bỏ nháp lỗi thời", async () => {
    const t = await planned();
    await t.service.tick();
    expect(t.assistant.pending(1, "u1")).toHaveLength(1);
    t.say("u1", "Chị đăng ký rồi nhé", vnAt("2026-11-20", 11 * 60));
    t.setNow(vnAt("2026-11-20", 12 * 60));
    t.setReply(ANALYSIS.replace("đang cân nhắc", "đã đăng ký").replace('lan_toi="2026-11-20"', 'lan_toi="2026-11-27"'));
    await t.service.tick();
    expect(t.assistant.pending(1, "u1")).toHaveLength(0);
    expect(t.store.get(1, "u1")!.stage).toBe("đã đăng ký");
  });
});
