import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type EngineKind = "claude-code" | "codex" | "openai-compatible" | "anthropic-api";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateRequest {
  /** Vai trò, giọng văn, luật của trợ lý. */
  system?: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
}

export interface EngineConfig {
  kind: EngineKind;
  /** Để trống = mặc định của nhà cung cấp/CLI. */
  model?: string;
  /** openai-compatible / anthropic-api. */
  apiKey?: string;
  /** openai-compatible: ví dụ https://api.openai.com/v1 */
  baseUrl?: string;
  /** claude-code / codex: đường dẫn tới CLI nếu không có trên PATH. */
  cliPath?: string;
  /** Giới hạn thời gian mỗi lượt (ms). */
  timeoutMs?: number;
}

export interface Engine {
  readonly kind: EngineKind;
  generate(req: GenerateRequest): Promise<string>;
}

export class EngineError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "EngineError";
  }
}

/**
 * Thư mục rỗng riêng cho CLI chạy: để claude/codex không đọc AGENTS.md, CLAUDE.md
 * hay file của thư mục đang đứng — trợ lý chỉ biết những gì app đưa vào.
 */
export function engineSandboxDir(): string {
  const dir = path.join(os.tmpdir(), "tro-ly-cdn-engine");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * CLI (claude, codex) chạy mỗi lượt là một tiến trình mới, không nhớ hội thoại →
 * gộp lịch sử thành một prompt. Lượt cuối là tin cần trả lời.
 */
export function flattenConversation(messages: ChatMessage[]): string {
  if (messages.length === 0) throw new EngineError("Không có tin nhắn để trả lời");
  if (messages.length === 1) return messages[0].content;
  const history = messages
    .slice(0, -1)
    .map((m) => `${m.role === "user" ? "Người dùng" : "Trợ lý"}: ${m.content}`)
    .join("\n\n");
  const last = messages[messages.length - 1];
  return `<lich_su_hoi_thoai>\n${history}\n</lich_su_hoi_thoai>\n\nTin nhắn mới cần trả lời:\n${last.content}`;
}
