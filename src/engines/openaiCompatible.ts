import { type Engine, type EngineConfig, EngineError, type GenerateRequest } from "./types.js";

/** Nhà cung cấp có API chuẩn OpenAI Chat Completions. */
export const OPENAI_COMPATIBLE_PRESETS = [
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-5-mini" },
  { id: "gemini", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "" },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { id: "ollama", label: "Ollama (chạy trên máy)", baseUrl: "http://localhost:11434/v1", model: "" },
] as const;

export class OpenAICompatibleEngine implements Engine {
  readonly kind = "openai-compatible" as const;
  constructor(private readonly cfg: EngineConfig) {}

  async generate(req: GenerateRequest): Promise<string> {
    if (!this.cfg.baseUrl) throw new EngineError("Chưa nhập địa chỉ API (Base URL)");
    if (!this.cfg.model) throw new EngineError("Chưa nhập tên model");

    const messages = [
      ...(req.system ? [{ role: "system", content: req.system }] : []),
      ...req.messages,
    ];
    const signals = [AbortSignal.timeout(this.cfg.timeoutMs ?? 120_000), ...(req.signal ? [req.signal] : [])];
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.cfg.model, messages }),
        signal: AbortSignal.any(signals),
      });
    } catch (err) {
      throw new EngineError(`Không kết nối được ${this.cfg.baseUrl}: ${(err as Error).message}`);
    }
    const body = (await res.json().catch(() => ({}))) as {
      choices?: { message?: { content?: string | null } }[];
      error?: { message?: string } | string;
    };
    if (!res.ok) {
      const msg = typeof body.error === "string" ? body.error : body.error?.message;
      throw new EngineError(
        `Nhà cung cấp báo lỗi ${res.status}${msg ? `: ${msg}` : ""}`,
        res.status === 401 ? "API key sai hoặc đã bị thu hồi." : undefined,
      );
    }
    const text = body.choices?.[0]?.message?.content;
    if (!text) throw new EngineError("Nhà cung cấp trả về câu trả lời rỗng");
    return text.trim();
  }
}
