import { describe, expect, it, vi } from "vitest";
import { openDb } from "../server/db.js";
import { ContactStore, genderFromZalo, salutationOf } from "./contacts.js";
import { renderWelcome } from "../groups/logic.js";
import { renderScheduleText } from "../scheduler/render.js";
import { frameSystemPrompt } from "./replyPolicy.js";

describe("giới tính → cách gọi", () => {
  it("đọc giới tính hồ sơ Zalo, không rõ thì gọi bạn", () => {
    expect(genderFromZalo(0)).toBe("nam");
    expect(genderFromZalo("1")).toBe("nu");
    expect(genderFromZalo(undefined)).toBe("");
    expect(genderFromZalo(2)).toBe("");
    expect(salutationOf("nam")).toBe("anh");
    expect(salutationOf("nu")).toBe("chị");
    expect(salutationOf("")).toBe("bạn");
    expect(salutationOf(undefined)).toBe("bạn");
  });
});

describe("ContactStore", () => {
  const setup = (profiles: Record<string, { name: string; gender: "nam" | "nu" | "" }>) => {
    const db = openDb(":memory:");
    const fetcher = vi.fn(async (ids: string[]) => new Map(ids.filter((id) => profiles[id]).map((id) => [id, profiles[id]!])));
    return { db, fetcher, store: new ContactStore(db, 1, fetcher) };
  };

  it("hỏi Zalo người còn thiếu, lần sau không hỏi lại", async () => {
    const { store, fetcher } = setup({ a: { name: "Lan", gender: "nu" }, b: { name: "Minh", gender: "nam" } });
    const g = await store.ensure(["a", "b"], 1000);
    expect(g.get("a")).toBe("nu");
    expect(store.salutation("b")).toBe("anh");
    await store.ensure(["a", "b"], 2000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("Zalo không trả hồ sơ: ghi chưa rõ, không hỏi lại mỗi tin; 30 ngày sau thử lại", async () => {
    const { store, fetcher } = setup({});
    await store.ensure(["x"], 1000);
    expect(store.salutation("x")).toBe("bạn");
    await store.ensure(["x"], 2000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(store.needsFetch(["x"], 1000 + 31 * 86_400_000)).toEqual(["x"]);
  });

  it("chủ sửa tay thì giữ mãi, Zalo không ghi đè; trả về tự động được", async () => {
    const { store, fetcher } = setup({ a: { name: "Lan", gender: "nam" } });
    store.setManual("a", "nu", 1000);
    expect(store.needsFetch(["a"], 999_999_999_999)).toEqual([]);
    await store.ensure(["a"], 2000);
    expect(fetcher).not.toHaveBeenCalled();
    expect(store.get("a")).toMatchObject({ gender: "nu", source: "chu" });
    store.clearManual("a");
    await store.ensure(["a"], 3000);
    expect(store.get("a")).toMatchObject({ gender: "nam", source: "zalo" });
  });

  it("lỗi mạng thì im lặng, gọi bạn", async () => {
    const db = openDb(":memory:");
    const store = new ContactStore(db, 1, async () => {
      throw new Error("mất mạng");
    });
    expect((await store.ensure(["a"])).get("a")).toBe("");
    expect(store.needsFetch(["a"])).toEqual(["a"]);
  });
});

describe("biến {xung_ho}", () => {
  it("tin chào: một người theo giới tính, nhiều người là các bạn, viết hoa đầu câu", () => {
    const one = renderWelcome("{Xung_ho} {ten} ơi, chào {xung_ho}!", { members: [{ id: "1", name: "Lan", gender: "nu" }], groupName: "G", memberCount: 3, adderName: "" }, false);
    expect(one.text).toBe("Chị Lan ơi, chào chị!");
    const many = renderWelcome(
      "Chào {xung_ho} {ten}",
      { members: [{ id: "1", name: "Lan", gender: "nu" }, { id: "2", name: "Minh", gender: "nam" }], groupName: "G", memberCount: 3, adderName: "" },
      true,
    );
    expect(many.text).toBe("Chào các bạn @Lan và @Minh");
    expect(many.mentions.map((m) => m.uid)).toEqual(["1", "2"]);
    const unknown = renderWelcome("Chào {xung_ho} {ten}", { members: [{ id: "1", name: "Linh" }], groupName: "G", memberCount: 3, adderName: "" }, false);
    expect(unknown.text).toBe("Chào bạn Linh");
  });

  it("lịch gửi: điền theo từng người nhận, nhóm là mọi người, tin không biến giữ nguyên", () => {
    expect(renderScheduleText("Chào {xưng hô} {tên}, tối nay học nhé", { isGroup: false, name: "Minh", gender: "nam" })).toBe("Chào anh Minh, tối nay học nhé");
    expect(renderScheduleText("{Xung_ho} {ten} ơi", { isGroup: false, name: "Lan", gender: "nu" })).toBe("Chị Lan ơi");
    expect(renderScheduleText("Chào {xung_ho} {ten}", { isGroup: false, name: "Linh", gender: "" })).toBe("Chào bạn Linh");
    expect(renderScheduleText("Chào {xưng hô} trong {tên}", { isGroup: true, name: "Lớp K12" })).toBe("Chào mọi người trong Lớp K12");
    expect(renderScheduleText("Không có biến {abc}", { isGroup: false, name: "A", gender: "nam" })).toBe("Không có biến {abc}");
  });

  it("khung hướng dẫn AI ghi đúng cách gọi", () => {
    const base = { ownerName: "Thảo", profileName: "CSKH", isGroup: false, groupName: "", personName: "Lan", sendMode: "draft" as const };
    expect(frameSystemPrompt({ ...base, salutation: "chị" })).toContain('gọi Lan là "chị"');
    expect(frameSystemPrompt(base)).toContain('gọi Lan là "bạn"');
    expect(frameSystemPrompt(base)).toContain("Không đoán giới tính từ tên");
  });
});
