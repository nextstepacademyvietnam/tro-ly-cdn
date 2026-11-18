import type { MessageRow } from "../channels/zalo/inbox.js";
import type { Profile } from "../core/profiles.js";

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}…` : t);
const line = (m: MessageRow, owner: string) => {
  const who = m.direction === "in" ? "Khách" : m.source === "ai" ? "Trợ lý" : owner;
  return `${who}: ${m.text ?? "[không phải chữ: ảnh, nhãn dán, tệp…]"}`;
};

// ---------- Gợi ý gắn nhãn tính cách cho khách mới ----------

/** Mô tả ngắn một tính cách để AI chọn (tên, nhãn, trợ lý là ai, mục tiêu, việc được làm). */
export function personaBrief(p: Profile): string {
  const parts = [p.identity.who, p.identity.goal, p.identity.can].map((x) => x.trim()).filter(Boolean);
  return `- Mã ${p.id}: "${p.name}" (nhãn Zalo "${p.tag}")${parts.length ? ` — ${clip(parts.join(" "), 500)}` : ""}`;
}

export function triageSystemPrompt(ownerName: string, personas: Profile[]): string {
  return [
    `Bạn giúp ${ownerName || "chủ tài khoản"} phân loại người nhắn Zalo riêng cho họ, để chọn trợ lý AI nào lo người đó.`,
    "Các trợ lý (tính cách) đang có:",
    ...personas.map(personaBrief),
    "",
    "Đọc đoạn chat rồi chọn MỘT trợ lý hợp nhất nếu người này là khách hoặc khách tiềm năng đúng việc của trợ lý đó",
    "(hỏi sản phẩm, khoá học, giá, lịch, đăng ký, hỗ trợ sau mua…).",
    "Chọn KHÔNG khi là người nhà, bạn bè, đồng nghiệp, nhân viên nội bộ, đối tác, người chào hàng, quảng cáo, tin rác,",
    "hoặc chưa đủ thông tin để biết họ cần gì. Phân vân thì chọn KHÔNG: gắn nhầm thì trợ lý sẽ nói chuyện với người không nên.",
    "",
    "Chỉ trả về đúng một dòng, không viết gì khác:",
    '<chon ma="MÃ">lý do ngắn, dưới 20 chữ</chon>',
    "hoặc",
    "<khong>lý do ngắn</khong>",
  ].join("\n");
}

export function triageUserPrompt(name: string, messages: MessageRow[], owner: string): string {
  return [`Người nhắn: ${name || "(không rõ tên)"}`, "Đoạn chat (cũ trước, mới sau):", ...messages.map((m) => clip(line(m, owner), 400))].join("\n");
}

export type TriageResult = { kind: "pick"; profileId: number; reason: string } | { kind: "none"; reason: string } | { kind: "invalid" };

export function parseTriage(raw: string, allowed: number[]): TriageResult {
  const pick = /<chon\s+ma="?(\d+)"?\s*>([\s\S]*?)<\/chon>/i.exec(raw);
  if (pick) {
    const id = Number(pick[1]);
    if (!allowed.includes(id)) return { kind: "invalid" };
    return { kind: "pick", profileId: id, reason: clip(pick[2]!.trim(), 200) };
  }
  const none = /<khong>([\s\S]*?)<\/khong>/i.exec(raw);
  if (none) return { kind: "none", reason: clip(none[1]!.trim(), 200) };
  return { kind: "invalid" };
}

// ---------- Học hỏi đáp từ cách chủ trả lời ----------

/** Một lượt: khách hỏi gì, chủ trả lời thế nào (có thể là bản chủ sửa từ nháp AI). */
export interface LearnPair {
  threadName: string;
  question: string;
  answer: string;
  /** Bản AI soạn trước khi chủ sửa (nếu có). */
  aiDraft?: string;
}

export function learnSystemPrompt(profileName: string, existing: { question: string; answer: string }[]): string {
  return [
    `Bạn giúp chủ doanh nghiệp xây bộ "câu hỏi thường gặp" cho trợ lý AI "${profileName}" trên Zalo.`,
    "Bạn được xem các lượt khách hỏi và CHÍNH CHỦ trả lời (hoặc chủ sửa lại câu trợ lý soạn). Đó là cách trả lời đúng.",
    "Rút ra tối đa 8 cặp hỏi đáp DÙNG LẠI ĐƯỢC cho nhiều khách:",
    "- Câu hỏi viết chung, như khách hay hỏi. Câu trả lời giữ đúng thông tin chủ đưa (giá, lịch, link, cách đăng ký…), giọng của chủ.",
    "- Bỏ tên người, số điện thoại, số tài khoản, chi tiết riêng của một khách. Không bịa thông tin chủ không nói.",
    "- Bỏ lời chào hỏi xã giao, chuyện riêng, câu chỉ đúng cho một người.",
    "- Khi chủ sửa câu trợ lý: chú ý chỗ chủ sửa (thông tin sai, thiếu, giọng chưa hợp) và đưa cách đúng vào câu trả lời.",
    "- Không lặp lại các hỏi đáp đã có dưới đây. Nếu chủ trả lời KHÁC hỏi đáp đã có, vẫn đưa ra kèm câu trả lời mới.",
    existing.length ? `\nHỏi đáp đã có:\n${existing.map((f) => `- H: ${clip(f.question, 200)} | Đ: ${clip(f.answer, 300)}`).join("\n")}` : "",
    "",
    "Trả về đúng dạng này cho mỗi cặp, không viết gì khác. Không có gì đáng rút ra thì trả về <khong_co/>.",
    "<hoi_dap><hoi>câu hỏi</hoi><dap>câu trả lời</dap><vi_sao>rút ra từ đâu, dưới 20 chữ</vi_sao></hoi_dap>",
  ].join("\n");
}

export function learnUserPrompt(pairs: LearnPair[]): string {
  return pairs
    .map((p, i) =>
      [
        `### Lượt ${i + 1} (${p.threadName || "khách"})`,
        `Khách: ${clip(p.question, 800)}`,
        p.aiDraft ? `Trợ lý soạn: ${clip(p.aiDraft, 800)}` : "",
        `${p.aiDraft ? "Chủ sửa lại và gửi" : "Chủ trả lời"}: ${clip(p.answer, 1200)}`,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}

export interface LearnedFaq {
  question: string;
  answer: string;
  evidence: string;
}

export function parseLearned(raw: string): LearnedFaq[] {
  const out: LearnedFaq[] = [];
  for (const m of raw.matchAll(/<hoi_dap>([\s\S]*?)<\/hoi_dap>/gi)) {
    const body = m[1]!;
    const q = /<hoi>([\s\S]*?)<\/hoi>/i.exec(body)?.[1]?.trim() ?? "";
    const a = /<dap>([\s\S]*?)<\/dap>/i.exec(body)?.[1]?.trim() ?? "";
    const e = /<vi_sao>([\s\S]*?)<\/vi_sao>/i.exec(body)?.[1]?.trim() ?? "";
    if (q && a) out.push({ question: q.slice(0, 500), answer: a.slice(0, 3000), evidence: e.slice(0, 300) });
    if (out.length >= 8) break;
  }
  return out;
}
