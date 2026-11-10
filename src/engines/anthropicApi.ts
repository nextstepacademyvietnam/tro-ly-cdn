import Anthropic from "@anthropic-ai/sdk";
import { type Engine, type EngineConfig, EngineError, type GenerateRequest } from "./types.js";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

/** Gọi Claude bằng API key từ platform.claude.com (tính tiền theo token). */
export class AnthropicApiEngine implements Engine {
  readonly kind = "anthropic-api" as const;
  private readonly client: Anthropic;

  constructor(private readonly cfg: EngineConfig) {
    if (!cfg.apiKey) throw new EngineError("Chưa nhập Anthropic API key");
    this.client = new Anthropic({ apiKey: cfg.apiKey, timeout: cfg.timeoutMs ?? 180_000 });
  }

  async generate(req: GenerateRequest): Promise<string> {
    try {
      const response = await this.client.beta.messages.create(
        {
          model: this.cfg.model || DEFAULT_ANTHROPIC_MODEL,
          max_tokens: 16000,
          ...(req.system ? { system: req.system } : {}),
          messages: req.messages,
          // Bộ lọc an toàn từ chối thì tự chuyển sang model dự phòng phù hợp.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        { signal: req.signal },
      );
      if (response.stop_reason === "refusal") {
        throw new EngineError("Claude từ chối trả lời yêu cầu này");
      }
      const text = response.content
        .flatMap((b) => (b.type === "text" ? [b.text] : []))
        .join("")
        .trim();
      if (!text) throw new EngineError("Claude trả về câu trả lời rỗng");
      return text;
    } catch (err) {
      if (err instanceof EngineError) throw err;
      if (err instanceof Anthropic.AuthenticationError) {
        throw new EngineError("Anthropic API key sai hoặc đã bị thu hồi", "Tạo key mới ở platform.claude.com.");
      }
      if (err instanceof Anthropic.RateLimitError) {
        throw new EngineError("Đã chạm giới hạn tốc độ của Anthropic, thử lại sau ít phút");
      }
      if (err instanceof Anthropic.APIError) {
        throw new EngineError(`Anthropic báo lỗi ${err.status ?? ""}: ${err.message}`);
      }
      throw new EngineError(`Không gọi được Anthropic: ${(err as Error).message}`);
    }
  }
}
