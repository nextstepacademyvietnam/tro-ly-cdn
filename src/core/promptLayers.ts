/**
 * Hướng dẫn AI chia 4 tầng theo mức độ thay đổi:
 *   0. Luật an toàn      — app giữ, không đổi (replyPolicy.frameSystemPrompt)
 *   1. Danh tính         — ít đổi (vài tháng): các ô bên dưới
 *   2. Kiến thức         — thỉnh thoảng: tài liệu + hỏi đáp
 *   3. Thông tin thời điểm — thường xuyên: ghi chú có ngày hết hạn
 * Ghép theo thứ tự ít đổi → hay đổi, để phần đầu ổn định (AI trả lời nhanh, rẻ hơn).
 */
import type { PersonaDoc } from "./documents.js";

export interface Identity {
  who: string;
  goal: string;
  voice: string;
  can: string;
  cannot: string;
  handoff: string;
  notes: string;
}

export const IDENTITY_FIELDS: { key: keyof Identity; title: string; hint: string; example: string }[] = [
  {
    key: "who",
    title: "Trợ lý là ai, thay mặt ai",
    hint: "Tên trợ lý, làm việc cho ai, doanh nghiệp làm gì — 1–3 câu.",
    example: "Bạn là Mai, trợ lý của chị Thảo ở Next Step Group — đơn vị đào tạo kỹ năng bán hàng cho chủ doanh nghiệp nhỏ.",
  },
  {
    key: "goal",
    title: "Mục tiêu khi trò chuyện",
    hint: "Trợ lý cần đạt điều gì sau mỗi cuộc trò chuyện.",
    example: "Giúp khách hiểu khoá học có hợp với họ không, trả lời đúng thông tin, và hẹn lịch gọi tư vấn khi khách quan tâm.",
  },
  {
    key: "voice",
    title: "Giọng và xưng hô",
    hint: "Xưng gì, gọi khách thế nào, thân mật hay trang trọng, có dùng biểu tượng cảm xúc không.",
    example: "Xưng em, gọi anh/chị. Thân thiện, lễ phép, mở đầu bằng \"Dạ\". Không dùng biểu tượng cảm xúc quá 1 lần mỗi tin.",
  },
  {
    key: "can",
    title: "Được làm",
    hint: "Những việc trợ lý được tự làm, mỗi dòng một việc.",
    example: "- Giới thiệu khoá học theo tài liệu\n- Gửi lịch khai giảng đang mở\n- Hỏi nhu cầu, quy mô doanh nghiệp của khách",
  },
  {
    key: "cannot",
    title: "Không được làm",
    hint: "Những điều riêng của doanh nghiệp bạn mà trợ lý không được nói/làm (luật an toàn chung đã có ở tầng 0).",
    example: "- Không so sánh với đơn vị khác\n- Không hứa cam kết doanh số\n- Không nói về học phí doanh nghiệp (gói riêng)",
  },
  {
    key: "handoff",
    title: "Khi nào chuyển cho chủ (bổ sung)",
    hint: "Thêm các trường hợp riêng cần người thật, ngoài các trường hợp tầng 0 đã có.",
    example: "- Khách muốn đăng ký từ 3 người trở lên\n- Khách là doanh nghiệp muốn đào tạo nội bộ",
  },
  {
    key: "notes",
    title: "Ghi chú thêm",
    hint: "Điều khác cần dặn mà không thuộc ô nào ở trên.",
    example: "Nếu khách hỏi ngoài giờ (sau 21h), trả lời ngắn và hẹn sáng hôm sau chị Thảo liên hệ.",
  },
];

export const EMPTY_IDENTITY: Identity = { who: "", goal: "", voice: "", can: "", cannot: "", handoff: "", notes: "" };

export function parseIdentity(raw: unknown): Identity {
  let obj: Record<string, unknown> = {};
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      obj = { notes: raw };
    }
  } else if (raw && typeof raw === "object") obj = raw as Record<string, unknown>;
  const out = { ...EMPTY_IDENTITY };
  for (const f of IDENTITY_FIELDS) out[f.key] = typeof obj[f.key] === "string" ? (obj[f.key] as string) : "";
  return out;
}

export const identityLength = (i: Identity) => IDENTITY_FIELDS.reduce((n, f) => n + i[f.key].length, 0);

export interface Faq {
  question: string;
  answer: string;
}

export interface TimelyNote {
  text: string;
  /** Ngày hết hạn YYYY-MM-DD (gồm cả ngày đó); null = tới khi xoá. */
  expiresOn: string | null;
}

const VN_OFFSET = 7 * 3_600_000;
export const vnToday = (now = Date.now()) => new Date(now + VN_OFFSET).toISOString().slice(0, 10);
const WEEKDAYS = ["Chủ nhật", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy"];
export function vnTodayLabel(now = Date.now()): string {
  const d = new Date(now + VN_OFFSET);
  return `${WEEKDAYS[d.getUTCDay()]}, ${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}
const fmtDate = (ymd: string) => ymd.split("-").reverse().join("/");

/** Ghi chú còn hiệu lực hôm nay (giờ Việt Nam). */
export function activeNotes<T extends TimelyNote>(notes: T[], now = Date.now()): T[] {
  const today = vnToday(now);
  return notes.filter((n) => !n.expiresOn || n.expiresOn >= today);
}

/** Tầng 1 → 3 ghép thành phần riêng của một tính cách (đặt sau tầng 0). */
export function composeProfilePrompt(p: {
  name: string;
  identity: Identity;
  docs: PersonaDoc[];
  faqs: Faq[];
  notes: TimelyNote[];
  now?: number;
}): string {
  const now = p.now ?? Date.now();
  const out: string[] = [];

  out.push(`# Tầng 1 — Vai trò "${p.name}"`);
  const filled = IDENTITY_FIELDS.filter((f) => p.identity[f.key].trim());
  if (filled.length) for (const f of filled) out.push(`## ${f.title}\n${p.identity[f.key].trim()}`);
  else out.push("(Chủ chưa viết hướng dẫn riêng — trả lời lịch sự, ngắn gọn, đúng luật an toàn.)");

  out.push("# Tầng 2 — Kiến thức sản phẩm", "Chỉ dùng thông tin dưới đây để trả lời về sản phẩm, giá, chính sách; không có thì nói chưa có thông tin.");
  if (p.docs.length) for (const d of p.docs) out.push(`<tai_lieu ten="${d.name.replace(/"/g, "'")}">\n${d.text}\n</tai_lieu>`);
  const faqs = p.faqs.filter((f) => f.question.trim() && f.answer.trim());
  if (faqs.length) out.push("## Câu hỏi thường gặp\n" + faqs.map((f) => `Hỏi: ${f.question.trim()}\nĐáp: ${f.answer.trim()}`).join("\n\n"));
  if (!p.docs.length && !faqs.length) out.push("(Chưa có tài liệu.)");

  const notes = activeNotes(p.notes, now);
  out.push(`# Tầng 3 — Thông tin thời điểm\nHôm nay là ${vnTodayLabel(now)}.`);
  if (notes.length) {
    out.push(
      "Thông tin đang có hiệu lực (ưu tiên hơn tài liệu nếu khác nhau):\n" +
        notes.map((n) => `- ${n.text.trim()}${n.expiresOn ? ` (hiệu lực đến hết ${fmtDate(n.expiresOn)})` : ""}`).join("\n"),
    );
  } else out.push("Không có thông báo thời điểm nào đang hiệu lực.");

  return out.join("\n\n");
}

// ---------- AI tối ưu: đọc / viết tầng 1 theo các ô ----------

/** Tầng 1 viết thành văn bản có tiêu đề "### <tên ô>" — dạng AI đọc và đề xuất lại. */
export function identityToText(i: Identity): string {
  return IDENTITY_FIELDS.map((f) => `### ${f.title}\n${i[f.key].trim()}`).join("\n\n");
}

/** Đọc ngược văn bản "### <tên ô>" thành các ô; tiêu đề lạ dồn vào "Ghi chú thêm". */
export function textToIdentity(text: string): Identity {
  const out = { ...EMPTY_IDENTITY };
  const norm = (s: string) => s.trim().toLocaleLowerCase("vi").replace(/[:：]$/, "");
  const parts = text.split(/^#{2,4}\s+/m).map((s) => s.trim()).filter(Boolean);
  const extra: string[] = [];
  for (const part of parts) {
    const nl = part.indexOf("\n");
    const title = nl < 0 ? part : part.slice(0, nl);
    const body = nl < 0 ? "" : part.slice(nl + 1).trim();
    const field = IDENTITY_FIELDS.find((f) => norm(f.title) === norm(title) || norm(title).startsWith(norm(f.title).split(",")[0]));
    if (field) out[field.key] = out[field.key] ? `${out[field.key]}\n${body}` : body;
    else extra.push(nl < 0 ? part : `${title}\n${body}`);
  }
  if (!parts.length && text.trim()) out.notes = text.trim();
  if (extra.length) out.notes = [out.notes, ...extra].filter(Boolean).join("\n\n");
  return out;
}
