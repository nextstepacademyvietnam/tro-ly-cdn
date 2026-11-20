export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly hint?: string) {
    super(message);
  }
}

/** Tài khoản Zalo đang chọn — mọi yêu cầu gửi kèm để server biết thao tác trên nick nào. */
let currentAccount: number | null = null;
export const setCurrentAccount = (id: number | null) => {
  currentAccount = id;
};
export const getCurrentAccount = () => currentAccount;

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body) headers["content-type"] = "application/json";
  if (currentAccount) headers["x-cdn-account"] = String(currentAccount);
  const res = await fetch(path, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers,
    body: init.body ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `Lỗi ${res.status}`, res.status, data.hint);
  return data as T;
}

/** Ảnh nhỏ hơn mức này và cạnh dài không quá MAX_IMAGE_SIDE thì tải nguyên bản. */
const SMALL_IMAGE_BYTES = 1.5 * 1024 * 1024;
const MAX_IMAGE_SIDE = 2560;

/**
 * Thu nhỏ ảnh lớn ngay trên trình duyệt (cạnh dài tối đa 2560 px, JPEG 85%) trước khi tải lên.
 * Ảnh gốc điện thoại / ảnh thiết kế PNG có thể quá giới hạn của server (413); Zalo cũng tự nén khi gửi.
 * GIF giữ nguyên để không mất chuyển động. Không đọc được ảnh thì trả file gốc.
 */
async function shrinkImage(file: File): Promise<{ name: string; blob: Blob }> {
  if (!file.type.startsWith("image/") || file.type === "image/gif") return { name: file.name, blob: file };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { name: file.name, blob: file };
  }
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= SMALL_IMAGE_BYTES) {
    bitmap.close();
    return { name: file.name, blob: file };
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff"; // nền trắng cho ảnh PNG trong suốt khi đổi sang JPEG
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.85));
  if (!blob) return { name: file.name, blob: file };
  return { name: file.name.replace(/\.[^.]+$/, "") + ".jpg", blob };
}

/** Tải một ảnh lên kho ảnh của app (dùng cho lời chào, lịch gửi). Ném lỗi dễ hiểu khi không được. */
export async function uploadImage(file: File): Promise<{ id: number; url: string; name: string }> {
  if (!file.type.startsWith("image/")) throw new Error(`"${file.name}" không phải ảnh`);
  const { name, blob } = await shrinkImage(file);
  try {
    return await api<{ id: number; url: string; name: string }>("/api/media", { body: { name, dataBase64: await readAsBase64(blob) } });
  } catch (err) {
    if (err instanceof ApiError && err.status === 413) throw new Error(`Ảnh "${file.name}" quá lớn, hãy chọn ảnh dưới 10 MB`);
    throw err;
  }
}

export function readAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("Không đọc được file"));
    r.readAsDataURL(file);
  });
}

/** Lưu cài đặt nhỏ của người xem (giao diện, tài khoản đang chọn). Có thể bị chặn → bỏ qua. */
export const prefs = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`cdn.${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(`cdn.${key}`, value);
    } catch {
      /* chế độ riêng tư */
    }
  },
};

export type EngineKind = "claude-code" | "codex" | "openai-compatible" | "anthropic-api";

export interface EngineConfigView {
  kind: EngineKind;
  model?: string;
  baseUrl?: string;
  cliPath?: string;
  hasApiKey?: boolean;
}

export interface Preset {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
}

export interface CheckResult {
  ok: boolean;
  ms: number;
  reply?: string;
  error?: string;
  hint?: string;
}

export interface Account {
  id: number;
  name: string;
  offTag: string;
  state: string;
  ownName: string;
  paused: boolean;
  unread: number;
  pendingDrafts: number;
  /** Hội thoại có nháp chờ duyệt hoặc đang chờ người thật. */
  needsAction: number;
  unreadConversations: number;
  activeSchedules: number;
  trackedGroups: number;
  /** Khách tới lượt chăm sóc chủ động trong hôm nay. */
  careDue: number;
}

export interface Notice {
  id: number;
  threadId: string;
  kind: string;
  text: string;
  createdAt: number;
  read: boolean;
}

export interface Draft {
  id: number;
  threadId: string;
  text: string;
  handoff: boolean;
  createdAt: number;
  /** "care" = tin chăm sóc chủ động; "schedule" = tin lịch gửi do AI soạn. */
  origin?: "reply" | "care" | "schedule";
  /** Cách gửi khi duyệt (tin lịch gửi). */
  sendOpts?: { mentionAll: boolean; urgency: 0 | 1 | 2 } | null;
}

export type CareStatus = "active" | "paused" | "stopped";
export interface CarePlan {
  accountId: number;
  threadId: string;
  profileId: number | null;
  profileName: string;
  name: string;
  lastMessageAt: number;
  status: CareStatus;
  stage: string;
  facts: string;
  summary: string;
  needs: string;
  goal: string;
  everyDays: number;
  nextAt: number | null;
  reason: string;
  stopReason: string;
  locked: boolean;
  analyzedAt: number;
  lastCareAt: number;
  careCount: number;
}
export interface CareLogEntry {
  id: number;
  kind: "analyze" | "draft" | "sent" | "skip" | "edit" | "stop" | "error";
  text: string;
  at: number;
}
export interface CareSettings {
  enabled: boolean;
  rules: string;
  maxPerDay: number;
}

export interface ProfileFile {
  id: number;
  name: string;
  bytes: number;
  chars: number;
}

export interface Profile {
  id: number;
  accountId: number;
  name: string;
  tag: string;
  identity: import("./layers").Identity;
  sendMode: "draft" | "auto";
  applies: "both" | "user" | "group";
  priority: number;
  /** Chăm sóc khách chủ động của tính cách. */
  care?: CareSettings;
  files: (ProfileFile & { created_at: number })[];
  faqs: import("./layers").Faq[];
  notes: import("./layers").TimelyNote[];
}

export type BotState =
  | { kind: "profile"; profileId: number; name: string; source: "web" | "zalo"; conflict: string[] }
  | { kind: "off"; source: "web" | "zalo" }
  | { kind: "none" };
