import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  type Engine,
  type EngineConfig,
  EngineError,
  type GenerateRequest,
  engineSandboxDir,
  flattenConversation,
} from "./types.js";

/**
 * Dùng gói Claude (Pro/Max) qua chính Claude Code mà chủ máy đã cài và tự đăng nhập
 * (`claude` → /login). App không đọc, không lưu, không chuyển tiếp token của Claude.
 * Toàn bộ công cụ có sẵn của Claude Code bị tắt: ở đây nó chỉ soạn chữ.
 */
export class ClaudeCodeEngine implements Engine {
  readonly kind = "claude-code" as const;
  constructor(private readonly cfg: EngineConfig) {}

  async generate(req: GenerateRequest): Promise<string> {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), this.cfg.timeoutMs ?? 180_000);
    req.signal?.addEventListener("abort", () => abortController.abort(), { once: true });

    // Không để API key trong môi trường lấn quyền đăng nhập gói subscription.
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    try {
      const stream = query({
        prompt: flattenConversation(req.messages),
        options: {
          systemPrompt: req.system ?? "",
          tools: [],
          maxTurns: 1,
          settingSources: [],
          cwd: engineSandboxDir(),
          persistSession: false,
          abortController,
          env,
          ...(this.cfg.model ? { model: this.cfg.model } : {}),
          ...(this.cfg.cliPath ? { pathToClaudeCodeExecutable: this.cfg.cliPath } : {}),
        },
      });
      for await (const msg of stream) {
        if (msg.type !== "result") continue;
        if (msg.subtype === "success" && !msg.is_error) return msg.result.trim();
        const detail = "result" in msg && typeof msg.result === "string" ? msg.result : msg.subtype;
        throw new EngineError(`Claude Code báo lỗi: ${detail}`, LOGIN_HINT);
      }
      throw new EngineError("Claude Code không trả về kết quả", LOGIN_HINT);
    } catch (err) {
      if (err instanceof EngineError) throw err;
      if (abortController.signal.aborted) throw new EngineError("Claude Code trả lời quá lâu, đã huỷ");
      throw new EngineError(`Không chạy được Claude Code: ${(err as Error).message}`, LOGIN_HINT);
    } finally {
      clearTimeout(timer);
    }
  }
}

const LOGIN_HINT =
  "Cài Claude Code (https://claude.com/claude-code), mở terminal gõ `claude`, đăng nhập bằng tài khoản Claude của bạn rồi thử lại.";
