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

describe("lưu lead vào CRM", () => {
  it("lần đầu tạo bản ghi, lần sau cập nhật đúng bản ghi; chỉ ghi trường bảng có; tra ra ngay", async () => {
    const db = openDb(":memory:");
    const inbox = new Inbox(db, 1);
    const calls: { method: string; url: string; body: { record: Record<string, string> } | null }[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      if (String(url).includes("/crm/tables")) {
        return new Response(JSON.stringify({ tables: [
          { name: "Contact", label: "Liên hệ", sections: [{ fields: [{ name: "Name" }, { name: "Phone" }, { name: "Note" }] }] },
          { name: "lien_he_moi__bot", label: "Liên hệ mới - Bot", sections: [{ fields: [{ name: "Name" }, { name: "Phone" }, { name: "bot_care_summary" }] }] },
        ] }));
      }
      return new Response(JSON.stringify({ data: { record: { id: "r1", Name: "Anh Long", Status: "Mới-x", CreatedOn: "2026-11-18 03:00:00" }, success: true } }));
    }) as typeof fetch;
    const crm = new CrmService({ db, cred: () => ({ apiKey: "k", shopId: "s", contactTable: "Contact", workshopTable: "" }), fetch: fake, now: () => NOW });
    const tables = await crm.tables();
    expect(crm.defaultTable(tables)).toBe("lien_he_moi__bot");
    await expect(crm.saveLead(1, "k1", { table: "lien_he_moi__bot", name: "", phone: "123", note: "" })).rejects.toThrow(/chưa đúng/);
    const a = await crm.saveLead(1, "k1", { table: "lien_he_moi__bot", name: "Anh Long", phone: "0912 345 678", note: "Hỏi lịch khai giảng" });
    expect(a).toEqual({ recordId: "r1", created: true });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toContain("/crm/lien_he_moi__bot/records");
    expect(post.body).toEqual({ record: { Name: "Anh Long", Phone: "0912345678", bot_care_summary: "Hỏi lịch khai giảng" } });
    expect(crm.matches(["0912345678"]).map((m) => m.recordId)).toEqual(["r1"]);
    const b = await crm.saveLead(1, "k1", { table: "lien_he_moi__bot", name: "Anh Long", phone: "0912345678", note: "Đã hẹn gọi thứ 5" });
    expect(b.created).toBe(false);
    expect(calls.at(-1)).toMatchObject({ method: "PUT", body: { record: { id: "r1", bot_care_summary: "Đã hẹn gọi thứ 5" } } });
    expect(crm.saved(1, "k1")).toHaveLength(1);
    expect(crm.defaultTable(tables)).toBe("lien_he_moi__bot");
    void inbox;
  });
});
