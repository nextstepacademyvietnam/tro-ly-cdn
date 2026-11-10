import { describe, expect, it } from "vitest";
import { buildSystemPrompt, extractText } from "./documents.js";

describe("đọc file hướng dẫn", () => {
  it("txt/md: bỏ BOM, chuẩn hoá NFC và dòng trống", async () => {
    const nfd = "Ba\u0300i 1\r\n\r\n\r\n\r\nGia\u0301 1.999.000đ";
    const text = await extractText("bang-gia.md", Buffer.from("\uFEFF" + nfd, "utf8"));
    expect(text).toBe("Bài 1\n\nGiá 1.999.000đ");
  });

  it("từ chối loại file lạ, file rỗng, .doc cũ", async () => {
    await expect(extractText("anh.png", Buffer.from("x"))).rejects.toThrow(/Chưa hỗ trợ/);
    await expect(extractText("trong.txt", Buffer.from("   "))).rejects.toThrow(/không có nội dung/);
    await expect(extractText("cu.docx", Buffer.from("không phải zip"))).rejects.toThrow(/Word/);
    await expect(extractText("hong.pdf", Buffer.from("không phải pdf"))).rejects.toThrow(/PDF/);
  });

  it("ghép hướng dẫn và tài liệu", () => {
    expect(buildSystemPrompt("Bạn là trợ lý.", [])).toBe("Bạn là trợ lý.");
    const p = buildSystemPrompt("Bạn là trợ lý.", [{ name: 'Giá "mới"', text: "Khoá A: 1tr" }]);
    expect(p).toContain('<tai_lieu ten="Giá \'mới\'">\nKhoá A: 1tr\n</tai_lieu>');
    expect(p.startsWith("Bạn là trợ lý.")).toBe(true);
  });
});
