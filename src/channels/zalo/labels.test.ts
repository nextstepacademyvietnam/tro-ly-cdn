import { describe, expect, it } from "vitest";
import { applyLabelChange, conversationKey, hasLabel, labelSummaries, type LabelData } from "./labels.js";

const L = (id: number, text: string, conversations: string[]): LabelData => ({
  id, text, textKey: "", conversations, color: "#ccc", offset: id, emoji: "", createTime: 0,
});

describe("nhãn Zalo thật", () => {
  const base = [L(1, "Khách VIP", ["u1", "g77"]), L(2, "Bot CSKH", ["u2"]), L(3, "Không bot", [])];
  const bot = ["Bot CSKH", "Bot Công việc", "Không bot"];

  it("gắn nhãn tính cách: gỡ nhãn trợ lý khác, giữ nguyên nhãn phân loại của chủ", () => {
    const r = applyLabelChange([...base, L(4, "Bot Công việc", ["u1"])], "u1", "user", "Bot CSKH", bot);
    expect(hasLabel(r.labels, "Bot CSKH", "u1")).toBe(true);
    expect(hasLabel(r.labels, "Bot Công việc", "u1")).toBe(false);
    expect(hasLabel(r.labels, "Khách VIP", "u1")).toBe(true);
    expect(r.created).toBeNull();
  });

  it("tắt bot = gắn nhãn Không bot; bỏ nhãn = gỡ hết nhãn trợ lý", () => {
    const off = applyLabelChange(base, "u2", "user", "Không bot", bot);
    expect(hasLabel(off.labels, "Không bot", "u2")).toBe(true);
    expect(hasLabel(off.labels, "Bot CSKH", "u2")).toBe(false);
    const none = applyLabelChange(off.labels, "u2", "user", null, bot);
    expect(bot.some((n) => hasLabel(none.labels, n, "u2"))).toBe(false);
  });

  it("nhãn chưa có thì tạo mới với id và thứ tự kế tiếp", () => {
    const r = applyLabelChange(base, "u9", "user", "Bot Công việc", bot, 123);
    expect(r.created).toBe("Bot Công việc");
    const made = r.labels.find((l) => l.text === "Bot Công việc")!;
    expect(made).toMatchObject({ id: 4, offset: 4, conversations: ["u9"], createTime: 123 });
    expect(base.find((l) => l.text === "Bot Công việc")).toBeUndefined(); // không sửa mảng gốc
  });

  it("nhóm ghi theo kiểu Zalo đang dùng (g + id), và nhận ra cả id có/không tiền tố", () => {
    expect(conversationKey("55", "group", base)).toBe("g55");
    expect(conversationKey("55", "group", [L(1, "X", ["g-12"])])).toBe("g-55");
    const r = applyLabelChange(base, "77", "group", "Bot CSKH", bot);
    expect(r.labels.find((l) => l.text === "Bot CSKH")!.conversations).toContain("g77");
    expect(hasLabel(r.labels, "Khách VIP", "77")).toBe(true);
  });

  it("tên nhãn so không phân biệt hoa thường; tóm tắt không lộ id", () => {
    const r = applyLabelChange(base, "u3", "user", "bot cskh", bot);
    expect(r.created).toBeNull();
    expect(hasLabel(r.labels, "Bot CSKH", "u3")).toBe(true);
    expect(labelSummaries(base)[0]).toEqual({ name: "Khách VIP", color: "#ccc", emoji: "", count: 2 });
  });
});
