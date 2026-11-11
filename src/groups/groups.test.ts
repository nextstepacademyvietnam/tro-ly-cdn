import { describe, expect, it } from "vitest";
import { openDb } from "../server/db.js";
import { memberIdsFromInfo, normalizeGroupEvent } from "../channels/zalo/groupEvents.js";
import type { GroupDetail } from "../channels/zalo/channel.js";
import {
  DEFAULT_WELCOME,
  type EventRow,
  afterQuiet,
  bucketKey,
  computeStats,
  csvRow,
  diffMembers,
  inQuiet,
  planPrivateSlot,
  renderWelcome,
  sanitizeWelcome,
} from "./logic.js";
import { type GroupChannel, GroupTracker } from "./tracker.js";

/** Giờ Việt Nam → mốc thời gian. */
const T = (ymd: string, hm = "10:00") => Date.parse(`${ymd}T${hm}:00+07:00`);
const MIN = 60_000;

describe("sự kiện nhóm", () => {
  it("chuẩn hoá vào bằng link, được thêm, rời, bị mời ra; bỏ sự kiện khác", () => {
    const base = { groupId: "g1", groupName: "Lớp K12", time: String(T("2026-11-11")) };
    const link = normalizeGroupEvent({ type: "join", data: { ...base, sourceId: "u1", updateMembers: [{ id: "u1", dName: "Lan" }] } });
    expect(link).toMatchObject({ kind: "join", via: "link", members: [{ id: "u1", name: "Lan" }], at: T("2026-11-11") });
    const added = normalizeGroupEvent({ type: "join", data: { ...base, sourceId: "boss", updateMembers: [{ id: "u2", dName: "Minh" }] } });
    expect(added).toMatchObject({ via: "added", actorId: "boss" });
    expect(normalizeGroupEvent({ type: "remove_member", data: { ...base, sourceId: "boss", updateMembers: [{ id: "u2" }] } })?.kind).toBe("remove");
    expect(normalizeGroupEvent({ type: "leave", data: { ...base, updateMembers: [{ id: "u3" }] } })?.kind).toBe("leave");
    expect(normalizeGroupEvent({ type: "new_pin_topic", data: base })).toBeNull();
    expect(normalizeGroupEvent({ type: "join", data: { ...base, updateMembers: [] } })).toBeNull();
  });

  it("đọc id thành viên từ memVerList", () => {
    expect(memberIdsFromInfo({ memVerList: ["111_0", "222_3", "111_1"] })).toEqual(["111", "222"]);
    expect(memberIdsFromInfo({ memberIds: ["9"] })).toEqual(["9"]);
  });
});

describe("logic", () => {
  it("dựng tin chào có tag đúng vị trí", () => {
    const r = renderWelcome(
      "Chào mừng {ten} đến {ten_nhom}!",
      { members: [{ id: "a", name: "Lan" }, { id: "b", name: "Minh" }, { id: "c", name: "Hà" }], groupName: "K12", memberCount: 50, adderName: "" },
      true,
    );
    expect(r.text).toBe("Chào mừng @Lan, @Minh và @Hà đến K12!");
    for (const m of r.mentions) expect(r.text.slice(m.pos, m.pos + m.len)).toMatch(/^@/);
    expect(r.mentions.map((m) => r.text.slice(m.pos, m.pos + m.len))).toEqual(["@Lan", "@Minh", "@Hà"]);
    const p = renderWelcome("Chào {ten}, {ten_nhom} có {so_thanh_vien} người", { members: [{ id: "a", name: "Lan" }], groupName: "K12", memberCount: 50, adderName: "" }, false);
    expect(p).toEqual({ text: "Chào Lan, K12 có 50 người", mentions: [] });
  });

  it("giờ yên lặng qua nửa đêm", () => {
    expect(inQuiet(T("2026-11-11", "22:00"), "21:30", "07:30")).toBe(true);
    expect(inQuiet(T("2026-11-11", "06:00"), "21:30", "07:30")).toBe(true);
    expect(inQuiet(T("2026-11-11", "12:00"), "21:30", "07:30")).toBe(false);
    expect(afterQuiet(T("2026-11-11", "23:10"), "21:30", "07:30")).toBe(T("2026-11-12", "07:30"));
  });

  it("xếp lời chào riêng: giãn cách, trần mỗi giờ, né giờ yên lặng", () => {
    const cfg = sanitizeWelcome({ private: { enabled: true, minDelayMin: 2, maxDelayMin: 2, perHour: 3, perDay: 100 } });
    const now = T("2026-11-11", "10:00");
    const taken: number[] = [];
    for (let i = 0; i < 6; i++) taken.push(planPrivateSlot(now, taken, cfg, () => 0));
    expect(taken[1]! - taken[0]!).toBe(2 * MIN);
    for (const t of taken) expect(taken.filter((x) => x > t - 3_600_000 && x <= t).length).toBeLessThanOrEqual(3);
    const night = planPrivateSlot(T("2026-11-11", "21:40"), [], cfg, () => 0);
    expect(night).toBe(T("2026-11-12", "07:30"));
  });

  it("đối chiếu: nhóm lớn trả thiếu thì không kết luận ai rời", () => {
    expect(diffMembers(["a", "b", "c"], ["a", "d"], 2)).toEqual({ joined: ["d"], left: ["b", "c"], trusted: true });
    expect(diffMembers(["a", "b", "c"], ["a"], 100)).toMatchObject({ left: [], trusted: false });
  });

  it("thống kê theo ngày/tuần/tháng và giữ chân", () => {
    const ev = (user: string, kind: EventRow["kind"], at: number, via = ""): EventRow => ({ user_id: user, user_name: user, kind, via, actor_id: via === "added" ? "boss" : "", actor_name: via === "added" ? "Sếp" : "", at });
    const events = [
      ev("a", "join", T("2026-10-01"), "link"),
      ev("b", "join", T("2026-10-01"), "added"),
      ev("b", "leave", T("2026-10-03")),
      ev("c", "join", T("2026-10-05"), "added"),
      ev("d", "remove", T("2026-10-06")),
    ];
    const s = computeStats(events, { from: T("2026-10-01", "00:00"), to: T("2026-10-07", "23:59"), bucket: "day", now: T("2026-11-11"), currentMembers: 10 });
    expect(s.totals).toMatchObject({ joins: 3, leaves: 2, net: 1, leaveBy: { leave: 1, remove: 1, block: 0 }, joinBy: { link: 1, added: 2, diff: 0 } });
    expect(s.series).toHaveLength(7);
    expect(s.series[0]).toEqual({ key: "2026-10-01", joins: 2, leaves: 0 });
    expect(s.topAdders).toEqual([{ name: "Sếp", count: 2 }]);
    expect(s.retention.d7).toEqual({ cohort: 3, stayed: 2, percent: 67 });
    expect(bucketKey(T("2026-11-11"), "week")).toBe("2026-11-09"); // thứ Hai
    expect(bucketKey(T("2026-11-11"), "month")).toBe("2026-11");
    expect(bucketKey(T("2026-11-11", "23:30"), "day")).toBe("2026-11-11"); // giờ VN, không lệch sang UTC
  });

  it("CSV an toàn cho Excel", () => {
    expect(csvRow(["a,b", '"x"', "=SUM(1)", 3])).toBe('"a,b","""x""",\'=SUM(1),3');
  });
});

describe("GroupTracker", () => {
  function setup() {
    const db = openDb(":memory:");
    if (!db.prepare("SELECT id FROM accounts WHERE id = 1").get()) db.prepare("INSERT INTO accounts (id, name, created_at) VALUES (1, 'TK', 0)").run();
    let members = ["own", "boss", "a", "b"];
    const sent: { kind: string; to: string; text: string; mentions?: unknown[] }[] = [];
    let connected = true;
    const channel: GroupChannel = {
      isConnected: () => connected,
      ownId: () => "own",
      groups: async () => [{ id: "g1", name: "Lớp K12", memberCount: members.length, isAdmin: true }],
      groupDetail: async (): Promise<GroupDetail> => ({ id: "g1", name: "Lớp K12", totalMember: members.length, memberIds: [...members], adminIds: ["boss"], creatorId: "boss" }),
      memberNames: async (ids) => new Map(ids.map((id) => [id, `Tên ${id}`])),
      sendMention: async (gid, text, mentions) => (sent.push({ kind: "group", to: gid, text, mentions }), "m1"),
      sendText: async (uid, text) => (sent.push({ kind: "private", to: uid, text }), ["m2"]),
      sendImages: async () => [],
      recordOutbound: () => undefined,
    };
    const tracker = new GroupTracker(db, { channel: () => channel, accountIds: () => [1], isPaused: () => false, mediaPath: () => null, rand: () => 0 });
    return { db, tracker, sent, setMembers: (m: string[]) => (members = m), setConnected: (c: boolean) => (connected = c) };
  }
  const join = (ids: string[], at: number, actor = "") => ({
    kind: "join" as const,
    groupId: "g1",
    groupName: "Lớp K12",
    members: ids.map((id) => ({ id, name: `Tên ${id}` })),
    actorId: actor,
    via: (actor ? "added" : "link") as "added" | "link",
    at,
    isSelf: false,
  });

  it("theo dõi chụp mốc, không tính là vào mới; sự kiện tức thời được ghi", async () => {
    const t = setup();
    await t.tracker.track(1, "g1", T("2026-11-11", "09:00"));
    expect(t.tracker.events(1, "g1")).toHaveLength(0);
    await t.tracker.onChange(1, join(["x"], T("2026-11-11", "10:00"), "boss"));
    await t.tracker.onChange(1, join(["x"], T("2026-11-11", "10:00"), "boss")); // Zalo báo trùng
    await t.tracker.onChange(1, { ...join(["a"], T("2026-11-11", "11:00")), kind: "leave", via: "" });
    const ev = t.tracker.events(1, "g1");
    expect(ev.map((e) => [e.kind, e.user_id, e.via])).toEqual([["leave", "a", ""], ["join", "x", "added"]]);
    expect(t.tracker.group(1, "g1")?.member_count).toBe(4);
  });

  it("đối chiếu bắt người vào/rời lúc app tắt", async () => {
    const t = setup();
    await t.tracker.track(1, "g1", T("2026-11-11", "09:00"));
    t.setMembers(["own", "boss", "a", "z"]);
    expect(await t.tracker.reconcile(1, "g1", T("2026-11-12"))).toEqual([{ joined: 1, left: 1 }]);
    expect(t.tracker.events(1, "g1").map((e) => [e.kind, e.user_id, e.via])).toEqual([["leave", "b", "diff"], ["join", "z", "diff"]]);
  });

  it("luồng chào: gom người vào cùng đợt, tag tên, bỏ quản trị và người đã rời, không chào lại", async () => {
    const t = setup();
    await t.tracker.track(1, "g1", T("2026-11-11", "09:00"));
    t.tracker.setWelcome(1, "g1", { enabled: true, group: { enabled: true, batchSeconds: 120 }, private: { enabled: true, minDelayMin: 1, maxDelayMin: 1 } });
    const now = T("2026-11-11", "10:00");
    await t.tracker.onChange(1, join(["x"], now), now);
    await t.tracker.onChange(1, join(["y", "boss"], now + 30_000), now + 30_000);
    await t.tracker.onChange(1, { ...join(["y"], now + 50_000), kind: "leave", via: "" }, now + 50_000); // y rời trước lượt gửi

    await t.tracker.tick(now + 55_000);
    expect(t.sent).toHaveLength(0); // chưa tới hạn
    await t.tracker.tick(now + 10 * MIN);
    const group = t.sent.find((s) => s.kind === "group")!;
    expect(group.text).toContain("@Tên x");
    expect(group.text).not.toContain("Tên y");
    expect(group.text).not.toContain("boss");
    expect(t.sent.filter((s) => s.kind === "private").map((s) => s.to)).toEqual(["x"]);
    const log = t.tracker.welcomeLog(1, "g1");
    expect(log.find((w) => w.kind === "private" && (JSON.parse(w.members) as { id: string }[])[0]!.id === "y")?.status).toBe("skipped");

    // x vào lại trong 30 ngày: không chào lại.
    const before = t.sent.length;
    await t.tracker.onChange(1, { ...join(["x"], now + 20 * MIN), kind: "leave", via: "" }, now + 20 * MIN);
    await t.tracker.onChange(1, join(["x"], now + 21 * MIN), now + 21 * MIN);
    await t.tracker.tick(now + 60 * MIN);
    expect(t.sent.length).toBe(before);
  });

  it("Zalo mất kết nối: giữ lời chào chờ, quá 6 giờ thì bỏ", async () => {
    const t = setup();
    await t.tracker.track(1, "g1", T("2026-11-11", "09:00"));
    t.tracker.setWelcome(1, "g1", { enabled: true, group: { enabled: true, batchSeconds: 0 } });
    const now = T("2026-11-11", "10:00");
    await t.tracker.onChange(1, join(["x"], now), now);
    t.setConnected(false);
    await t.tracker.tick(now + MIN);
    expect(t.tracker.welcomeLog(1, "g1")[0]!.status).toBe("pending");
    await t.tracker.tick(now + 7 * 3_600_000);
    expect(t.tracker.welcomeLog(1, "g1")[0]).toMatchObject({ status: "skipped", error: "Zalo không kết nối quá lâu" });
  });

  it("cấu hình sai giá trị được kẹp về mức an toàn", () => {
    const c = sanitizeWelcome({ private: { perHour: 999, minDelayMin: 10, maxDelayMin: 1, templates: ["", "  "] }, quietStart: "25:00" });
    expect(c.private.perHour).toBe(60);
    expect(c.private.maxDelayMin).toBe(10);
    expect(c.private.templates).toEqual(DEFAULT_WELCOME.private.templates);
    expect(c.quietStart).toBe(DEFAULT_WELCOME.quietStart);
  });
});
