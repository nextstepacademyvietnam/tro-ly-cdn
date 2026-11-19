import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { openDb } from "../server/db.js";
import { Inbox } from "../channels/zalo/inbox.js";
import { SecretBox } from "../server/secrets.js";
import { CrmService, priorityOf } from "./service.js";
import { BATCH, PER_DAY, ZaloMatcher } from "./zaloMatch.js";

// 19/11/2026 10:00 giờ VN
const NOW = Date.UTC(2026, 10, 19, 3, 0, 0);
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19);

function setup(rows = 3) {
  const db = openDb(":memory:");
  const box = new SecretBox(crypto.randomBytes(32));
  let now = NOW;
  const crm = new CrmService({ db, box, cred: () => null, now: () => now });
  const leads = [
    // lead cũ, trạng thái chưa phù hợp → ưu tiên 1
    { id: "old", Name: "Cũ", Phone: "0911000000", Status: "Chưa phù hợp", CreatedOn: iso(NOW - 400 * DAY) },
    // lead mới → ưu tiên 0; tên CRM khác hẳn tên Zalo
    { id: "c1", Name: "Nguyễn Thị Phương Thảo", Phone: "0912345678", Status: "Mới", CreatedOn: iso(NOW - 3 * DAY), san_pham_chot: "PRO SALES" },
    ...Array.from({ length: rows }, (_, i) => ({ id: `n${i}`, Name: `Lead ${i}`, Phone: `09333000${String(i).padStart(2, "0")}`, Status: "Tiếp cận", CreatedOn: iso(NOW - 100 * DAY) })),
  ];
  crm.rebuild([{ table: "Contact", kind: "lead", rows: leads }]);
  const calls: string[][] = [];
  let fail: Error | null = null;
  const zalo = {
    isConnected: () => true,
    usersByPhones: async (phones: string[]) => {
      calls.push(phones);
      if (fail) throw fail;
      return new Map(phones.filter((p) => p === "0912345678").map((p) => [p, { uid: "u-thao", name: "Thảo Spa" }]));
    },
  };
  const notes: string[] = [];
  const m = new ZaloMatcher({ db, box, accountIds: () => [1], account: () => zalo, notify: (_a, t) => void notes.push(t), now: () => now });
  return { db, crm, m, calls, notes, setNow: (t: number) => (now = t), setFail: (e: Error | null) => (fail = e) };
}

describe("nối CRM → Zalo theo số điện thoại", () => {
  it("ưu tiên khách đang theo: lead 60 ngày, hoặc đang làm trong 180 ngày", () => {
    expect(priorityOf({ CreatedOn: iso(NOW - 10 * DAY), Status: "Chưa phù hợp" }, "lead", NOW)).toBe(0);
    expect(priorityOf({ CreatedOn: iso(NOW - 100 * DAY), Status: "Hẹn chốt" }, "lead", NOW)).toBe(0);
    expect(priorityOf({ CreatedOn: iso(NOW - 100 * DAY), Status: "Chưa sẵn sàng" }, "lead", NOW)).toBe(1);
    expect(priorityOf({ CreatedOn: iso(NOW - 400 * DAY), Status: "Mới" }, "lead", NOW)).toBe(1);
  });

  it("chỉ mục không lưu số trần; tìm khách đang theo trước, lead cũ sau cùng", async () => {
    const t = setup();
    expect(JSON.stringify(t.db.prepare("SELECT * FROM crm_index").all())).not.toContain("0912345678");
    await t.m.runAccount(1);
    expect(t.calls[0]![0]).toBe("0912345678");
    expect(t.calls[0]!.at(-1)).toBe("0911000000");
  });

  it("khách nhắn Zalo khớp lead qua uid, dù tên khác và hồ sơ Zalo không có số", async () => {
    const t = setup();
    await t.m.runAccount(1);
    const inbox = new Inbox(t.db, 1);
    const r = t.crm.lookup(1, "u-thao", inbox);
    expect(r.phones).toEqual([{ phone: "0912345678", from: "crm" }]);
    expect(r.matches[0]).toMatchObject({ name: "Nguyễn Thị Phương Thảo", status: "Mới" });
    expect(t.crm.note(1, "u-thao", inbox)).toContain("Sản phẩm đã chốt: PRO SALES");
    expect(t.crm.lookup(1, "u-khac", inbox).matches).toEqual([]);
    // Đã tìm thì không tìm lại tới 30 ngày.
    await t.m.runAccount(1);
    expect(t.calls).toHaveLength(1);
    t.setNow(NOW + 31 * DAY);
    await t.m.runAccount(1);
    expect(t.calls).toHaveLength(2);
  });

  it("mỗi lượt tối đa 20 số, trần mỗi ngày, nghỉ giờ yên lặng", async () => {
    const t = setup(400);
    await t.m.runAccount(1);
    expect(t.calls[0]).toHaveLength(BATCH);
    for (let i = 0; i < 40; i++) {
      t.setNow(NOW + (i + 1) * 3_600_000 / 6);
      await t.m.runAccount(1);
    }
    const total = t.calls.reduce((s, c) => s + c.length, 0);
    expect(total).toBeLessThanOrEqual(PER_DAY);
    const before = t.calls.length;
    t.setNow(Date.UTC(2026, 10, 19, 16, 0, 0)); // 23:00 VN
    await t.m.runAccount(1);
    expect(t.calls.length).toBe(before);
  });

  it("Zalo từ chối → nghỉ nick 24 giờ, báo chủ một lần", async () => {
    const t = setup();
    t.setFail(new Error("Bạn đã tìm kiếm quá nhiều"));
    await t.m.runAccount(1);
    await t.m.runAccount(1);
    expect(t.calls).toHaveLength(1);
    expect(t.notes).toHaveLength(1);
    expect(t.m.progress(1).pausedUntil).toBeGreaterThan(NOW);
    t.setFail(null);
    t.setNow(NOW + 25 * 3_600_000);
    await t.m.runAccount(1);
    expect(t.calls).toHaveLength(2);
    expect(t.m.progress(1)).toMatchObject({ withZalo: 1, priorityChecked: 4 });
  });
});

describe("đọc lại CRM khi chỉ mục dựng bằng bản cũ", () => {
  it("chỉ mục mới đọc nhưng thiếu số mã hoá → cần đọc lại ngay", () => {
    const db = openDb(":memory:");
    const box = new SecretBox(crypto.randomBytes(32));
    const old = new CrmService({ db, cred: () => null, now: () => NOW });
    old.rebuild([{ table: "Contact", kind: "lead", rows: [{ id: "a", Phone: "0912345678", CreatedOn: iso(NOW) }] }]);
    const neu = new CrmService({ db, box, cred: () => null, now: () => NOW + 60_000 });
    expect(neu.needsRefresh()).toBe(true);
    neu.rebuild([{ table: "Contact", kind: "lead", rows: [{ id: "a", Phone: "0912345678", CreatedOn: iso(NOW) }] }]);
    expect(neu.needsRefresh()).toBe(false);
  });
});
