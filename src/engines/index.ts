import { AnthropicApiEngine } from "./anthropicApi.js";
import { ClaudeCodeEngine } from "./claudeCode.js";
import { CodexEngine } from "./codex.js";
import { OpenAICompatibleEngine } from "./openaiCompatible.js";
import { type Engine, type EngineConfig, EngineError } from "./types.js";

export * from "./types.js";
export { OPENAI_COMPATIBLE_PRESETS } from "./openaiCompatible.js";

export function createEngine(cfg: EngineConfig): Engine {
  switch (cfg.kind) {
    case "claude-code":
      return new ClaudeCodeEngine(cfg);
    case "codex":
      return new CodexEngine(cfg);
    case "openai-compatible":
      return new OpenAICompatibleEngine(cfg);
    case "anthropic-api":
      return new AnthropicApiEngine(cfg);
    default:
      throw new EngineError(`Engine không hỗ trợ: ${(cfg as { kind: string }).kind}`);
  }
}

export interface CheckResult {
  ok: boolean;
  ms: number;
  reply?: string;
  error?: string;
  hint?: string;
}

/** Gửi một câu hỏi rất ngắn để xác nhận engine chạy được với cấu hình hiện tại. */
export async function checkEngine(cfg: EngineConfig): Promise<CheckResult> {
  const started = Date.now();
  try {
    const reply = await createEngine({ ...cfg, timeoutMs: Math.min(cfg.timeoutMs ?? 90_000, 90_000) }).generate({
      system: "Bạn đang được kiểm tra kết nối. Trả lời đúng một từ.",
      messages: [{ role: "user", content: "Trả lời đúng chữ: OK" }],
    });
    return { ok: true, ms: Date.now() - started, reply: reply.slice(0, 200) };
  } catch (err) {
    const e = err as EngineError;
    return { ok: false, ms: Date.now() - started, error: e.message, hint: e.hint };
  }
}
