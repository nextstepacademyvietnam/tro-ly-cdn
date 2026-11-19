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
