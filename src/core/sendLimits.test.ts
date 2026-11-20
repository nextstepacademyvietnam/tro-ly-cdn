import { describe, expect, it } from "vitest";
import { DEFAULT_SEND_LIMITS, normalizeLimits } from "./sendLimits.js";

describe("giới hạn tin tự gửi", () => {
  it("chưa đặt thì dùng mặc định; ô thiếu / sai giữ mặc định", () => {
    expect(normalizeLimits(undefined)).toEqual(DEFAULT_SEND_LIMITS);
    expect(normalizeLimits({ groupHour: "abc", privateHour: null, groupDay: "" })).toEqual(DEFAULT_SEND_LIMITS);
  });

  it("kẹp vào khoảng cho phép, làm tròn; mức 24 giờ không nhỏ hơn mức 1 giờ", () => {
    const l = normalizeLimits({ privateHour: 0, groupHour: 999, groupPerSenderHour: 7.6, privateDay: 3, groupDay: 10 });
    expect(l.privateHour).toBe(1);
    expect(l.groupHour).toBe(100);
    expect(l.groupPerSenderHour).toBe(8);
    expect(l.privateDay).toBe(3);
    expect(l.groupDay).toBe(100);
  });
});
