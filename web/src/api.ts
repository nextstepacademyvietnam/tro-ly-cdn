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

export function readAsBase64(file: File): Promise<string> {
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
  files: (ProfileFile & { created_at: number })[];
  faqs: import("./layers").Faq[];
  notes: import("./layers").TimelyNote[];
}

export type BotState =
  | { kind: "profile"; profileId: number; name: string; source: "web" | "zalo"; conflict: string[] }
  | { kind: "off"; source: "web" | "zalo" }
  | { kind: "none" };
