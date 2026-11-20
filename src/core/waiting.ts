import { fold } from "./replyPolicy.js";

/** Khách nhắn riêng mà chưa ai trả lời quá ngần này thì vào "Cần xử lý" (Khách chờ lâu). */
export const WAIT_REPLY_MS = 30 * 60_000;
/** Tin cũ hơn ngần này không tính nữa (tránh dồn cả hộp thư cũ vào Cần xử lý). */
export const WAIT_LOOKBACK_MS = 7 * 24 * 3_600_000;

const ACK = new Set([
  "ok", "oke", "okie", "okay", "okela", "uh", "u", "um", "uhm", "vang", "da", "da vang", "vang a", "da a", "cam on", "camon",
  "thanks", "thank", "thank you", "tks", "thks", "ty", "hihi", "haha", "hehe", "yes", "duoc", "duoc roi", "roi", "nhe", "nha",
]);
const POLITE = new Set(["a", "nhe", "nha", "nhen", "em", "anh", "chi", "ban", "ad", "shop", "nhieu", "ah", "ạ", "c", "e"]);

/**
 * Tin khép lại cuộc trò chuyện, không cần trả lời: nhãn dán, "ok", "cảm ơn ạ", "dạ vâng"…
 * Chỉ xét tin ngắn; câu có dấu hỏi luôn coi là cần trả lời.
 */
export function isClosingMessage(text: string | null, kind: string): boolean {
  if (kind === "chat.sticker" || kind === "chat.gif") return true;
  if (text === null) return false; // ảnh, video, tệp, tin thoại: khách gửi để người xem
  if (text.includes("?")) return false;
  let t = fold(text)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return true; // chỉ có biểu tượng cảm xúc
  if (t.length > 40) return false;
  // Bỏ chữ lặp kéo dài: "okkk", "okeee", "dạaa".
  t = t.replace(/(\p{L})\1{2,}/gu, "$1");
  const words = t.split(" ");
  while (words.length > 1 && POLITE.has(words[words.length - 1]!)) words.pop();
  const core = words.join(" ");
  if (ACK.has(core)) return true;
  // "ok cảm ơn", "dạ cảm ơn em", "vâng ok"
  return words.every((w, i) => ACK.has(w) || POLITE.has(w) || (i > 0 && ACK.has(`${words[i - 1]} ${w}`)) || (i + 1 < words.length && ACK.has(`${w} ${words[i + 1]}`)));
}
