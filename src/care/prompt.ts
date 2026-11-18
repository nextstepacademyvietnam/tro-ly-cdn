/**
 * Phần thuần của tính năng chăm sóc khách chủ động: lời dặn AI, đọc kết quả phân tích, dựng bản ghi hội thoại,
 * tính giờ gửi. Không đụng DB hay Zalo để test được.
 */
import { MARK_SILENT } from "../core/replyPolicy.js";

export const DAY_MS = 86_400_000;
/** Tần suất chăm sóc AI được chọn (ngày). */
export const MIN_EVERY_DAYS = 1;
export const MAX_EVERY_DAYS = 60;

export interface CarePlanUpdate {
  facts: string;
  summary: string;
  needs: string;
  stage: string;
  goal: string;
  everyDays: number | null;
  /** YYYY-MM-DD theo giờ Việt Nam, hoặc null nếu AI không ghi / ghi sai. */
  nextDay: string | null;
  reason: string;
  /** Có nội dung = AI đề nghị dừng chăm sóc khách này (lý do). */
  stop: string;
}

const tag = (raw: string, name: string): string => {
  const m = raw.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1]!.trim() : "";
};
const attr = (raw: string, name: string, key: string): string => {
  const m = raw.match(new RegExp(`<${name}\\s[^>]*${key}\\s*=\\s*"([^"]*)"`, "i"));
  return m ? m[1]!.trim() : "";
};

/** Đọc kết quả phân tích của AI (dạng thẻ). Thẻ thiếu thì để trống; số / ngày sai thì null. */
export function parseCarePlan(raw: string, today: string): CarePlanUpdate {
  const every = Number.parseInt(attr(raw, "lich", "moi_ngay"), 10);
  const day = attr(raw, "lich", "lan_toi");
  const validDay = /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`)) && day >= today ? day : null;
  return {
    facts: tag(raw, "ho_so"),
    summary: tag(raw, "tom_tat"),
    needs: tag(raw, "nhu_cau"),
    stage: tag(raw, "giai_doan").slice(0, 60),
    goal: tag(raw, "muc_tieu"),
    everyDays: Number.isFinite(every) ? Math.min(MAX_EVERY_DAYS, Math.max(MIN_EVERY_DAYS, every)) : null,
    nextDay: validDay,
    reason: tag(raw, "lich"),
    stop: tag(raw, "dung_cham_soc"),
  };
}

export interface TranscriptMessage {
  direction: "in" | "out";
  source: string;
  text: string | null;
  kind: string;
  created_at: number;
}

const hm = (ms: number) =>
  new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(ms);

/** Bản ghi hội thoại dạng chữ cho AI đọc: "[18/11 09:12] Khách: …" / "Bên mình: …". */
export function transcript(messages: TranscriptMessage[], customerName: string): string {
  return messages
    .map((m) => {
      const who = m.direction === "in" ? customerName || "Khách" : m.source === "ai" ? "Trợ lý" : "Bên mình";
      const body = m.text?.trim() || `[${m.kind}]`;
      return `[${hm(m.created_at)}] ${who}: ${body}`;
    })
    .join("\n");
}

export interface PlanSnapshot {
  stage: string;
  facts: string;
  summary: string;
  needs: string;
  goal: string;
  everyDays: number;
  nextDay: string;
  locked: boolean;
  careCount: number;
  lastCareDay: string;
}

/** Lời dặn AI phân tích khách và đề xuất kế hoạch chăm sóc. `persona` = hướng dẫn tầng 1–3 của tính cách. */
export function analysisSystemPrompt(o: { persona: string; rules: string; ownerName: string; profileName: string }): string {
  return `Bạn là trợ lý chăm sóc khách hàng của ${o.ownerName}, đang làm việc theo tính cách "${o.profileName}" dưới đây.
Nhiệm vụ lúc này KHÔNG phải trả lời khách, mà là đọc lại hội thoại với một khách và lập hồ sơ + kế hoạch chăm sóc tiếp theo,
như một nhân viên chăm sóc khách hàng giỏi ghi chép sau mỗi cuộc trò chuyện.

Trả về ĐÚNG các thẻ sau, không viết gì ngoài thẻ:
<giai_doan>một cụm ngắn: mới quan tâm / đang tìm hiểu / đang cân nhắc / đã đăng ký / đã mua / cần hỗ trợ / không còn nhu cầu…</giai_doan>
<ho_so>thông tin về khách rút ra từ hội thoại, mỗi dòng một ý bắt đầu bằng "- " (công việc, doanh nghiệp, quy mô, sản phẩm quan tâm, mốc hẹn, điều khách dặn…). Chỉ ghi điều khách đã nói, không đoán.</ho_so>
<tom_tat>tóm tắt những gì hai bên đã trao đổi, 2–5 câu, ghi rõ điều đã hứa hoặc còn dang dở</tom_tat>
<nhu_cau>nhu cầu, mong muốn, vướng mắc của khách (ngắn)</nhu_cau>
<lich moi_ngay="N" lan_toi="YYYY-MM-DD">vì sao chọn tần suất và ngày này (1 câu)</lich>
<muc_tieu>lần chăm sóc tới cần làm gì cụ thể (VD: gửi lịch khai giảng, hỏi khách đã xem tài liệu chưa, nhắc hạn ưu đãi)</muc_tieu>

Chọn tần suất theo độ "nóng" của khách: đang cân nhắc, sắp quyết định, có hẹn → 1–2 ngày; đang tìm hiểu → 3–5 ngày;
đã mua / đã xong việc → hỏi thăm thưa (7–30 ngày); khách bận, trả lời ngắn, chưa muốn nói chuyện → thưa hơn.
"lan_toi" phải từ hôm nay trở đi; có mốc hẹn khách nói thì bám theo mốc đó.
Nếu không nên chủ động nhắn khách này nữa (khách từ chối, xin dừng, chỉ hỏi một câu chung chung rồi thôi, là người quen / nội bộ,
hội thoại không phải với khách hàng) thì thay thẻ <lich> và <muc_tieu> bằng: <dung_cham_soc>lý do</dung_cham_soc>
${o.rules.trim() ? `\nCách chăm sóc riêng của tính cách này (ưu tiên làm theo):\n${o.rules.trim()}\n` : ""}
--- Hướng dẫn của tính cách ---
${o.persona}`;
}

/** Nội dung gửi kèm: kế hoạch hiện có + hội thoại. */
export function analysisUserPrompt(o: { today: string; customerName: string; salutation: string; plan: PlanSnapshot | null; transcript: string }): string {
  const p = o.plan;
  const current = p
    ? `Hồ sơ đang có:
- Giai đoạn: ${p.stage || "(chưa có)"}
- Thông tin khách:\n${p.facts || "(chưa có)"}
- Đã trao đổi: ${p.summary || "(chưa có)"}
- Nhu cầu: ${p.needs || "(chưa có)"}
- Đã chủ động chăm sóc ${p.careCount} lần${p.lastCareDay ? `, gần nhất ${p.lastCareDay}` : ""}
${p.locked ? `- Chủ đã khoá lịch: mỗi ${p.everyDays} ngày, lần tới ${p.nextDay}. Giữ nguyên hai số này trong thẻ <lich>.` : ""}`
    : "Chưa có hồ sơ (lần đầu phân tích khách này).";
  return `Hôm nay: ${o.today}.
Khách: ${o.customerName || "(chưa rõ tên)"} — gọi là "${o.salutation}".

${current}

Hội thoại (cũ → mới):
${o.transcript || "(chưa có tin nhắn)"}

Cập nhật hồ sơ (giữ ý cũ còn đúng, thêm ý mới) và lập kế hoạch chăm sóc tiếp theo.`;
}

/** Lời dặn AI soạn một tin chăm sóc chủ động. */
export function careMessageSystemPrompt(o: { persona: string; rules: string; ownerName: string; profileName: string; salutation: string }): string {
  return `Bạn là trợ lý của ${o.ownerName}, làm việc theo tính cách "${o.profileName}" dưới đây.
Lúc này bạn CHỦ ĐỘNG nhắn một khách đang được chăm sóc (khách chưa nhắn gì), theo kế hoạch chăm sóc đã lập.

Yêu cầu:
- Viết đúng một tin nhắn Zalo ngắn (1–4 câu), tự nhiên như người thật, đúng giọng của tính cách, gọi khách là "${o.salutation}".
- Bám mục tiêu của lần chăm sóc này và những gì đã trao đổi; nhắc đúng chi tiết khách đã nói để khách thấy được quan tâm thật.
- Không lặp lại tin chăm sóc trước, không mở đầu bằng lời xin lỗi làm phiền, không dồn ép mua hàng, không bịa thông tin
  ngoài tài liệu của tính cách.
- Chỉ trả về nội dung tin nhắn, không giải thích, không ghi tiêu đề.
- Nếu thấy lúc này chưa có lý do hợp lý để nhắn (khách vừa nói chuyện, mục tiêu không còn đúng…), trả về đúng ${MARK_SILENT}
${o.rules.trim() ? `\nCách chăm sóc riêng của tính cách này:\n${o.rules.trim()}\n` : ""}
--- Hướng dẫn của tính cách ---
${o.persona}`;
}

export function careMessageUserPrompt(o: { today: string; customerName: string; plan: PlanSnapshot; transcript: string }): string {
  return `Hôm nay: ${o.today}.
Khách: ${o.customerName || "(chưa rõ tên)"}.
Giai đoạn: ${o.plan.stage || "(chưa rõ)"}
Thông tin khách:
${o.plan.facts || "(chưa có)"}
Đã trao đổi: ${o.plan.summary || "(chưa có)"}
Nhu cầu: ${o.plan.needs || "(chưa rõ)"}
Mục tiêu lần chăm sóc này: ${o.plan.goal || "hỏi thăm, xem khách cần hỗ trợ gì thêm"}
Đã chủ động chăm sóc ${o.plan.careCount} lần${o.plan.lastCareDay ? `, gần nhất ${o.plan.lastCareDay}` : ""}.

Hội thoại gần đây (cũ → mới):
${o.transcript || "(chưa có tin nhắn)"}

Viết tin chăm sóc.`;
}

// ---------- Giờ gửi ----------

const VN_OFFSET = 7 * 3_600_000;
/** "YYYY-MM-DD" theo giờ Việt Nam của một mốc thời gian. */
export const vnDay = (ms: number) => new Date(ms + VN_OFFSET).toISOString().slice(0, 10);
/** Mốc thời gian của "YYYY-MM-DD" lúc HH:MM giờ Việt Nam. */
export const vnAt = (day: string, minutes: number) => Date.parse(`${day}T00:00:00Z`) - VN_OFFSET + minutes * 60_000;

/** Khung soạn tin chăm sóc trong ngày (giờ VN): 08:30–11:00, rải ngẫu nhiên để không dồn một lúc. */
export const CARE_WINDOW_START = 8 * 60 + 30;
export const CARE_WINDOW_END = 11 * 60;

/** Giờ soạn tin cho một ngày: một phút ngẫu nhiên trong khung buổi sáng. */
export function slotOnDay(day: string, rand: () => number = Math.random): number {
  return vnAt(day, CARE_WINDOW_START + Math.floor(rand() * (CARE_WINDOW_END - CARE_WINDOW_START)));
}

/** Ngày + N ngày (YYYY-MM-DD). */
export const addDays = (day: string, n: number) => vnDay(Date.parse(`${day}T12:00:00Z`) - VN_OFFSET + n * DAY_MS);

/** Đang trong giờ yên lặng 21:30–07:30 (giờ VN)? */
export function inQuietVN(ms: number): boolean {
  const d = new Date(ms + VN_OFFSET);
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return m >= 21 * 60 + 30 || m < 7 * 60 + 30;
}
