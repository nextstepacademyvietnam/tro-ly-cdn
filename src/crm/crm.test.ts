import { describe, expect, it } from "vitest";
import { openDb } from "../server/db.js";
import { Inbox } from "../channels/zalo/inbox.js";
import { CrmService, hashPhone, phonesIn, phonesOf, text } from "./service.js";

const NOW = Date.UTC(2026, 10, 18, 3, 0, 0);

function setup() {
  const db = openDb(":memory:");
  const inbox = new Inbox(db, 1);
  const crm = new CrmService({ db, cred: () => ({ apiKey: "k", shopId: "s", contactTable: "Contact", workshopTable: "ws" }), now: () => NOW });
  crm.rebuild([
    {
      table: "Contact",
      kind: "lead",
      rows: [
        { id: "c1", Name: "Nguyễn Văn A", Phone: "+84 912 345 678", Status: "Hẹn chốt", san_pham_chot: "PRO SALES", so_don_da_mua: 1, Owner_obj: { name: "Việt Hưng" }, CreatedOn: "2026-11-02T03:00:00", pancake_link: "https://pos.pages.fm/x" },
        { id: "c2", Name: "Không số", Status: "Mới" },
      ],
    },
    { table: "ws", kind: "workshop", rows: [{ id: "w1", Name: "A", Phones: ["0912345678"], Status: "Mới", xac_nhan_tham_gia: "Có", CreatedOn: "2026-11-10T01:00:00" }] },
  ]);
  const say = (thread: string, t: string) =>
    inbox.recordInbound(
      { threadId: thread, threadType: "user", senderId: thread, displayName: "Khách", messageId: `${thread}${t}`, text: t, isText: true, isSelf: false, mentions: [], msgType: "webchat", receivedAt: NOW },
      { conversationName: "Khách" },
    );
  return { db, inbox, crm, say };
}

describe("tra khách trong CRM", () => {
  it("đọc số điện thoại trong tin khách, bỏ số không phải di động", () => {
    expect(phonesIn("sđt anh 0912.345.678 nhé, hoặc +84 98 765 4321")).toEqual(["0912345678", "0987654321"]);
    expect(phonesIn("mã đơn 0212345678 và 12345")).toEqual([]);
    expect(phonesOf({ Phone: "84912345678", Phones: [{ phone_number: "0987654321" }] })).toEqual(["0912345678", "0987654321"]);
    expect(text({ name: "Việt Hưng" })).toBe("Việt Hưng");
  });

  it("chỉ mục không lưu số gốc; khách gõ số trong chat → khớp lead và đăng ký workshop", () => {
    const t = setup();
    const raw = JSON.stringify(t.db.prepare("SELECT * FROM crm_index").all());
    expect(raw).not.toContain("0912345678");
    expect(raw).toContain(hashPhone("0912345678"));
    t.say("k1", "Anh gửi sđt 0912 345 678 em nhé");
    const r = t.crm.lookup(1, "k1", t.inbox);
    expect(r.phones).toEqual([{ phone: "0912345678", from: "chat" }]);
    expect(r.matches.map((m) => [m.kind, m.status])).toEqual([["lead", "Hẹn chốt"], ["workshop", "Mới"]]);
    expect(r.matches[0]!.fields).toContainEqual(["Người phụ trách", "Việt Hưng"]);
    const note = t.crm.note(1, "k1", t.inbox);
    expect(note).toContain("trạng thái Hẹn chốt");
    expect(note).toContain("Sản phẩm đã chốt: PRO SALES");
    expect(note).toContain("KHÔNG tự xác nhận");
    expect(note).not.toContain("Việt Hưng");
  });

  it("chủ nhập số tay cho khách không gõ số; số sai thì báo; xoá thì thôi", () => {
    const t = setup();
    t.say("k2", "Chào em");
    expect(t.crm.lookup(1, "k2", t.inbox).matches).toEqual([]);
    expect(() => t.crm.link(1, "k2", "123")).toThrow(/chưa đúng/);
    t.crm.link(1, "k2", "0912 345 678");
    expect(t.crm.lookup(1, "k2", t.inbox).phones[0]).toEqual({ phone: "0912345678", from: "chu" });
    expect(t.crm.lookup(1, "k2", t.inbox).matches).toHaveLength(2);
    t.crm.link(1, "k2", "");
    expect(t.crm.lookup(1, "k2", t.inbox).phones).toEqual([]);
    expect(t.crm.indexedAt()).toBe(NOW);
  });
});
