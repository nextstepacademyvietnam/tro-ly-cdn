/**
 * Nhãn (Phân loại) thật của Zalo — cùng nhãn chủ gắn trên điện thoại / máy tính.
 * Hàm thuần: tính danh sách nhãn mới; channel.ts lo đọc/ghi lên Zalo.
 */
import type { ThreadType } from "./protocol.js";

export interface LabelData {
  id: number;
  text: string;
  textKey: string;
  conversations: string[];
  color: string;
  offset: number;
  emoji: string;
  createTime: number;
}

/** Màu cho nhãn trợ lý tự tạo (giống bảng màu Zalo). */
const PALETTE = ["#3fa1f5", "#f5a623", "#7ed321", "#bd10e0", "#d0021b", "#50e3c2", "#4a4a4a"];

const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase("vi") === b.trim().toLocaleLowerCase("vi");

/** Mọi cách Zalo có thể ghi id một hội thoại trong nhãn (nhóm có tiền tố g / g-). */
export function conversationVariants(threadId: string): Set<string> {
  const id = String(threadId);
  const ids = new Set([id, `g${id}`, `g-${id}`]);
  if (id.startsWith("g-")) ids.add(id.slice(2));
  else if (/^g\d+$/.test(id)) ids.add(id.slice(1));
  return ids;
}

/** Cách ghi id khi thêm vào nhãn: nhóm theo kiểu Zalo đang dùng trong dữ liệu sẵn có (mặc định "g" + id). */
export function conversationKey(threadId: string, type: ThreadType, labels: LabelData[]): string {
  if (type === "user") return String(threadId);
  const all = labels.flatMap((l) => l.conversations ?? []).map(String);
  if (all.some((c) => c.startsWith("g-"))) return `g-${threadId}`;
  return `g${threadId}`;
}

export interface LabelChange {
  labels: LabelData[];
  created: string | null;
}

/**
 * Gỡ hội thoại khỏi mọi nhãn trong `exclusive` (các nhãn tính cách + nhãn tắt bot),
 * rồi gắn vào `target` (null = chỉ gỡ). Nhãn đích chưa có thì tạo mới.
 */
export function applyLabelChange(
  current: LabelData[],
  threadId: string,
  type: ThreadType,
  target: string | null,
  exclusive: string[],
  now = Date.now(),
): LabelChange {
  const variants = conversationVariants(threadId);
  const touched = new Set([...exclusive, ...(target ? [target] : [])].map((n) => n.trim()).filter(Boolean));
  const labels = current.map((l) => {
    const isTouched = [...touched].some((n) => sameName(n, l.text));
    if (!isTouched) return l;
    return { ...l, conversations: (l.conversations ?? []).map(String).filter((c) => !variants.has(c)) };
  });
  let created: string | null = null;
  if (target) {
    let label = labels.find((l) => sameName(l.text, target));
    if (!label) {
      const maxId = labels.reduce((m, l) => Math.max(m, Number(l.id) || 0), 0);
      const maxOffset = labels.reduce((m, l) => Math.max(m, Number(l.offset) || 0), 0);
      label = {
        id: maxId + 1,
        text: target.trim(),
        textKey: "",
        conversations: [],
        color: PALETTE[labels.length % PALETTE.length],
        offset: maxOffset + 1,
        emoji: "",
        createTime: now,
      };
      labels.push(label);
      created = label.text;
    }
    label.conversations = [...label.conversations, conversationKey(threadId, type, current)];
  }
  return { labels, created };
}

export function hasLabel(labels: LabelData[], name: string, threadId: string): boolean {
  const v = conversationVariants(threadId);
  return labels.some((l) => sameName(l.text, name) && (l.conversations ?? []).some((c) => v.has(String(c))));
}

/** Tóm tắt để hiển thị: không lộ id hội thoại. */
export function labelSummaries(labels: LabelData[]) {
  return labels.map((l) => ({ name: l.text, color: l.color, emoji: l.emoji, count: (l.conversations ?? []).length }));
}
