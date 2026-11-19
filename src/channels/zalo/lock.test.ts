import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ZaloChannel } from "./channel.js";

/** Gọi hàm khoá riêng tư để thử (không cần Zalo thật). */
const acquire = (ch: ZaloChannel) => (ch as unknown as { acquireLock(): void }).acquireLock();
const release = (ch: ZaloChannel) => (ch as unknown as { releaseLock(): void }).releaseLock();

describe("khoá một nick một tiến trình", () => {
  const setup = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdn-lock-"));
    const ch = new ZaloChannel({} as never, dir, 1);
    return { ch, file: path.join(dir, "zalo-1.lock") };
  };

  it("khoá còn được người giữ ghi lại (tiến trình đang sống) → chặn", () => {
    const { ch, file } = setup();
    fs.writeFileSync(file, String(process.ppid));
    expect(() => acquire(ch)).toThrow(/đang giữ kết nối Zalo/);
  });

  it("khoá bỏ quên quá 2 phút → lấy lại được, dù số PID đã thuộc chương trình khác", () => {
    const { ch, file } = setup();
    fs.writeFileSync(file, String(process.ppid));
    const old = new Date(Date.now() - 5 * 60_000);
    fs.utimesSync(file, old, old);
    acquire(ch);
    expect(fs.readFileSync(file, "utf8")).toBe(String(process.pid));
    release(ch);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("nhận ra tin Zalo báo lại là của app", () => {
  it("trong lúc gửi: hội thoại được đánh dấu đang gửi, nội dung được nhớ trước khi Zalo trả mã tin", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdn-echo-"));
    const ch = new ZaloChannel({} as never, dir, 1) as unknown as {
      tracked<T>(t: string, text: string | null, fn: () => Promise<T>): Promise<T>;
      sentTextRecently(t: string, text: string | null): boolean;
      inflight: Map<string, number>;
    };
    let during = { inflight: 0, known: false };
    await ch.tracked("k1", "Chào anh, cảm ơn anh đã tham gia workshop", async () => {
      during = { inflight: ch.inflight.get("k1") ?? 0, known: ch.sentTextRecently("k1", " Chào anh, cảm ơn anh đã tham gia workshop ") };
    });
    expect(during).toEqual({ inflight: 1, known: true });
    expect(ch.inflight.has("k1")).toBe(false);
    expect(ch.sentTextRecently("k1", "Chào anh, cảm ơn anh đã tham gia workshop")).toBe(true);
    expect(ch.sentTextRecently("k1", "Tin chủ tự gõ")).toBe(false);
    expect(ch.sentTextRecently("k2", "Chào anh, cảm ơn anh đã tham gia workshop")).toBe(false);
  });
});
