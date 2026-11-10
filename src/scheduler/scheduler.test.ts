import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../server/db.js";
import { describeRecurrence, nextRun, vnDate, vnTime, type Recurrence } from "./recurrence.js";
import { GRACE_MS, ScheduleRunner, type ScheduleSender } from "./runner.js";
import { ScheduleStore, type ScheduleTarget } from "./store.js";

// 10/11/2026 là thứ Ba.
const T = (date: string, time: string) => vnTime(date, time);

describe("tính lượt gửi kế tiếp (giờ Việt Nam)", () => {
  it("một lần: trước giờ thì có, qua giờ thì hết", () => {
    const r: Recurrence = { type: "once", date: "2026-11-10", time: "20:00" };
    expect(nextRun(r, T("2026-11-10", "19:59"))).toBe(T("2026-11-10", "20:00"));
    expect(new Date(T("2026-11-10", "20:00")).toISOString()).toBe("2026-11-10T13:00:00.000Z");
    expect(nextRun(r, T("2026-11-10", "20:00"))).toBeNull();
  });

  it("hằng ngày, có ngày kết thúc", () => {
    const r: Recurrence = { type: "daily", date: "2026-11-10", time: "08:00", endDate: "2026-11-11" };
    expect(nextRun(r, T("2026-11-09", "12:00"))).toBe(T("2026-11-10", "08:00"));
    expect(nextRun(r, T("2026-11-10", "08:00"))).toBe(T("2026-11-11", "08:00"));
    expect(nextRun(r, T("2026-11-11", "08:00"))).toBeNull();
  });

  it("theo thứ trong tuần (T2, T4, T6)", () => {
    const r: Recurrence = { type: "weekly", date: "2026-11-10", time: "07:30", weekdays: [1, 3, 5] };
    expect(vnDate(nextRun(r, T("2026-11-10", "09:00"))!)).toBe("2026-11-11"); // thứ Tư
    expect(vnDate(nextRun(r, T("2026-11-13", "08:00"))!)).toBe("2026-11-16"); // thứ Sáu đã qua giờ → thứ Hai
  });

  it("hằng tháng ngày 31 rơi vào ngày cuối của tháng ngắn", () => {
    const r: Recurrence = { type: "monthly", date: "2026-11-01", time: "09:00", monthDay: 31 };
    expect(vnDate(nextRun(r, T("2026-11-01", "00:00"))!)).toBe("2026-11-30");
    expect(vnDate(nextRun(r, T("2026-11-30", "09:00"))!)).toBe("2026-12-31");
    expect(vnDate(nextRun(r, T("2027-01-31", "09:00"))!)).toBe("2027-02-28");
  });

  it("gần nửa đêm vẫn đúng ngày Việt Nam", () => {
    const r: Recurrence = { type: "daily", date: "2026-11-10", time: "23:30" };
    expect(new Date(nextRun(r, T("2026-11-10", "23:00"))!).toISOString()).toBe("2026-11-10T16:30:00.000Z");
    expect(vnDate(nextRun(r, T("2026-11-10", "23:45"))!)).toBe("2026-11-11");
  });

  it("mô tả cho người dùng", () => {
    expect(describeRecurrence({ type: "weekly", date: "2026-11-10", time: "08:00", weekdays: [5, 1, 0] })).toBe("Mỗi T2, T6, CN lúc 08:00");
    expect(describeRecurrence({ type: "once", date: "2026-11-10", time: "20:00" })).toBe("Một lần, 10/11/2026 lúc 20:00");
  });
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdn-sched-"));
  const store = new ScheduleStore(openDb(":memory:"), dir);
  const sent: { thread: string; text: string; images: number }[] = [];
  let connected = true;
  let failFor: string | null = null;
  const sender: ScheduleSender = {
    isConnected: () => connected,
    send: async (_acc, t, text, images) => {
      if (t.threadId === failFor) throw new Error("Zalo từ chối");
      sent.push({ thread: t.threadId, text, images: images.length });
    },
  };
  const runner = new ScheduleRunner(store, sender);
  return {
    store, runner, sent,
    setConnected: (v: boolean) => (connected = v),
    failOn: (id: string | null) => (failFor = id),
  };
}

const targets: ScheduleTarget[] = [
  { threadId: "g1", threadType: "group", name: "Nhóm học viên" },
  { threadId: "u1", threadType: "user", name: "Lan" },
];

describe("lưu lịch", () => {
  it("kiểm dữ liệu đầu vào", () => {
    const { store } = setup();
    const now = T("2026-11-10", "10:00");
    const rec: Recurrence = { type: "once", date: "2026-11-10", time: "20:00" };
    expect(() => store.create({ text: "", imageIds: [], targets, recurrence: rec }, now)).toThrow(/chữ hoặc ảnh/);
    expect(() => store.create({ text: "hi", imageIds: [], targets: [], recurrence: rec }, now)).toThrow(/ít nhất một/);
    expect(() => store.create({ text: "hi", imageIds: [], targets, recurrence: { ...rec, time: "09:00" } }, now)).toThrow(/đã qua/);
    expect(() => store.create({ text: "hi", imageIds: [99], targets, recurrence: rec }, now)).toThrow(/ảnh/);
    expect(() => store.create({ text: "hi", imageIds: [], targets, recurrence: { type: "weekly", date: "2026-11-10", time: "08:00", weekdays: [] } }, now)).toThrow(/thứ/);
  });

  it("ảnh: chỉ nhận JPG/PNG/WebP", () => {
    const { store } = setup();
    expect(() => store.saveImage("a.gif", crypto.randomBytes(100))).toThrow(/JPG/);
    const m = store.saveImage("C:/x/anh.PNG", crypto.randomBytes(100));
    expect(m).toMatchObject({ name: "anh.PNG", mime: "image/png" });
    expect(fs.existsSync(store.mediaPath(m))).toBe(true);
  });

  it("tạm dừng, chạy lại bỏ qua lượt đã trôi, huỷ thì không chạy lại được, nhân bản lịch đã qua", () => {
    const { store } = setup();
    const now = T("2026-11-10", "10:00");
    const s = store.create({ text: "Chào buổi sáng", imageIds: [], targets, recurrence: { type: "daily", date: "2026-11-10", time: "08:00" } }, now);
    expect(s.nextRunAt).toBe(T("2026-11-11", "08:00"));
    store.setStatus(s.id, "paused", now);
    const resumed = store.setStatus(s.id, "active", T("2026-11-13", "09:00"));
    expect(resumed.nextRunAt).toBe(T("2026-11-14", "08:00"));
    store.setStatus(s.id, "cancelled");
    expect(() => store.setStatus(s.id, "active")).toThrow(/huỷ/);
    expect(store.list({ threadId: "u1" })).toHaveLength(1);
    expect(store.list({ threadId: "khac" })).toHaveLength(0);

    const once = store.create({ text: "x", imageIds: [], targets, recurrence: { type: "once", date: "2026-11-10", time: "20:00" } }, now);
    const copy = store.duplicate(once.id, T("2026-11-12", "10:00"));
    expect(copy.recurrence.date).toBe("2026-11-13");
    expect(copy.status).toBe("active");
  });
});

describe("bộ chạy lịch", () => {
  it("đến giờ thì gửi mọi hội thoại, lịch một lần chuyển Hoàn tất", async () => {
    const { store, runner, sent } = setup();
    const img = store.saveImage("anh.jpg", crypto.randomBytes(50));
    const s = store.create({ text: "Tối nay 20h học nhé", imageIds: [img.id], targets, recurrence: { type: "once", date: "2026-11-10", time: "20:00" } }, T("2026-11-10", "10:00"));
    await runner.tick(T("2026-11-10", "19:59"));
    expect(sent).toHaveLength(0);
    await runner.tick(T("2026-11-10", "20:00"));
    expect(sent).toEqual([
      { thread: "g1", text: "Tối nay 20h học nhé", images: 1 },
      { thread: "u1", text: "Tối nay 20h học nhé", images: 1 },
    ]);
    expect(store.get(s.id)).toMatchObject({ status: "done", nextRunAt: null });
    expect(store.runs(s.id).map((r) => r.status)).toEqual(["sent", "sent"]);
    await runner.tick(T("2026-11-10", "20:01"));
    expect(sent).toHaveLength(2);
  });

  it("mất kết nối: gửi bù trong 30 phút, quá 30 phút ghi Lỡ giờ rồi sang lượt sau", async () => {
    const { store, runner, sent, setConnected } = setup();
    const s = store.create({ text: "Nhắc", imageIds: [], targets: [targets[0]], recurrence: { type: "daily", date: "2026-11-10", time: "08:00" } }, T("2026-11-10", "07:00"));
    setConnected(false);
    await runner.tick(T("2026-11-10", "08:00"));
    expect(sent).toHaveLength(0);
    setConnected(true);
    await runner.tick(T("2026-11-10", "08:20"));
    expect(sent).toHaveLength(1);
    expect(store.get(s.id)!.nextRunAt).toBe(T("2026-11-11", "08:00"));

    setConnected(false);
    await runner.tick(T("2026-11-11", "08:00") + GRACE_MS + 1000);
    expect(store.runs(s.id)[0]).toMatchObject({ status: "missed" });
    expect(store.get(s.id)!.nextRunAt).toBe(T("2026-11-12", "08:00"));
  });

  it("một hội thoại lỗi không chặn hội thoại khác; gửi lại thành công", async () => {
    const { store, runner, sent, failOn } = setup();
    const s = store.create({ text: "Hi", imageIds: [], targets, recurrence: { type: "once", date: "2026-11-10", time: "20:00" } }, T("2026-11-10", "10:00"));
    failOn("g1");
    await runner.tick(T("2026-11-10", "20:00"));
    const runs = store.runs(s.id);
    expect(runs.find((r) => r.threadId === "g1")).toMatchObject({ status: "failed", error: "Zalo từ chối" });
    expect(sent.map((x) => x.thread)).toEqual(["u1"]);
    failOn(null);
    await runner.retry(runs.find((r) => r.threadId === "g1")!.id);
    expect(store.runs(s.id).find((r) => r.threadId === "g1")!.status).toBe("sent");
  });

  it("lịch tạm dừng không gửi; Gửi ngay không đổi lượt kế tiếp", async () => {
    const { store, runner, sent } = setup();
    const s = store.create({ text: "Hi", imageIds: [], targets: [targets[1]], recurrence: { type: "daily", date: "2026-11-10", time: "20:00" } }, T("2026-11-10", "10:00"));
    store.setStatus(s.id, "paused", T("2026-11-10", "10:00"));
    await runner.tick(T("2026-11-10", "20:00"));
    expect(sent).toHaveLength(0);
    const before = store.get(s.id)!.nextRunAt;
    await runner.sendNow(s.id);
    expect(sent).toHaveLength(1);
    expect(store.runs(s.id)[0].manual).toBe(true);
    expect(store.get(s.id)!.nextRunAt).toBe(before);
  });
});
