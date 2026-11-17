import { capitalize, salutationOf } from "../core/contacts.js";

/**
 * Điền biến trong tin lịch gửi theo từng người nhận. Nhận cả kiểu tiếng Việt (ô soạn tin chèn kiểu này)
 * lẫn kiểu không dấu:
 *   {xưng hô} / {xung_ho} → anh / chị / bạn theo giới tính (nhóm: "mọi người")
 *   {Xưng hô} / {Xung_ho} → như trên, viết hoa chữ đầu (dùng đầu câu)
 *   {tên} / {ten}         → tên người nhận (nhóm: tên nhóm)
 * Tin không có biến thì giữ nguyên, nên lịch cũ gửi y như trước.
 */
const VARS = /\{(xưng hô|Xưng hô|xung_ho|Xung_ho|tên|ten)\}/g;

export const hasScheduleVars = (text: string) => new RegExp(VARS.source).test(text);

export function renderScheduleText(text: string, r: { isGroup: boolean; name: string; gender?: string }): string {
  if (!hasScheduleVars(text)) return text;
  const xungHo = r.isGroup ? "mọi người" : salutationOf(r.gender);
  const name = r.name.trim() || (r.isGroup ? "nhóm" : xungHo);
  return text
    .replace(VARS, (_, key: string) => (key === "tên" || key === "ten" ? name : key[0] === "X" ? capitalize(xungHo) : xungHo))
    .replace(/[ \t]{2,}/g, " ");
}
