import path from "node:path";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_DOC_CHARS = 150_000;
export const SUPPORTED_EXTENSIONS = [".txt", ".md", ".docx", ".pdf"] as const;

export class DocumentError extends Error {}

/** Rút chữ từ file hướng dẫn chủ tải lên. Chữ tiếng Việt được chuẩn hoá về NFC. */
export async function extractText(fileName: string, data: Buffer): Promise<string> {
  if (data.length > MAX_FILE_BYTES) throw new DocumentError("File quá lớn (tối đa 10 MB)");
  const ext = path.extname(fileName).toLowerCase();
  let text: string;
  switch (ext) {
    case ".txt":
    case ".md":
      text = data.toString("utf8").replace(/^﻿/, "");
      break;
    case ".docx": {
      const mammoth = await import("mammoth");
      try {
        text = (await mammoth.default.extractRawText({ buffer: data })).value;
      } catch {
        throw new DocumentError("Không đọc được file Word này (chỉ hỗ trợ .docx, không hỗ trợ .doc cũ)");
      }
      break;
    }
    case ".pdf": {
      const { extractText: pdfText, getDocumentProxy } = await import("unpdf");
      try {
        const pdf = await getDocumentProxy(new Uint8Array(data));
        text = (await pdfText(pdf, { mergePages: true })).text;
      } catch {
        throw new DocumentError("Không đọc được file PDF này");
      }
      if (!text.trim()) throw new DocumentError("PDF này là ảnh chụp, không có chữ để đọc. Hãy dùng bản Word hoặc PDF có chữ.");
      break;
    }
    default:
      throw new DocumentError(`Chưa hỗ trợ loại file ${ext || "này"}. Dùng ${SUPPORTED_EXTENSIONS.join(", ")}.`);
  }
  text = text.normalize("NFC").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) throw new DocumentError("File không có nội dung chữ");
  if (text.length > MAX_DOC_CHARS) throw new DocumentError(`File quá dài (${text.length.toLocaleString("vi-VN")} ký tự, tối đa ${MAX_DOC_CHARS.toLocaleString("vi-VN")})`);
  return text;
}

export interface PersonaDoc {
  name: string;
  text: string;
}

/** Ghép hướng dẫn và tài liệu thành system prompt gửi cho AI. */
export function buildSystemPrompt(persona: string, docs: PersonaDoc[]): string {
  const parts = [persona.trim()];
  if (docs.length) {
    parts.push(
      "Dưới đây là tài liệu của chủ. Chỉ dùng thông tin trong đó để trả lời; không có thì nói chưa có thông tin.",
      ...docs.map((d) => `<tai_lieu ten="${d.name.replace(/"/g, "'")}">\n${d.text}\n</tai_lieu>`),
    );
  }
  return parts.filter(Boolean).join("\n\n");
}
