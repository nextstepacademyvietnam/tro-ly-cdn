import { spawn } from "node:child_process";
import {
  type Engine,
  type EngineConfig,
  EngineError,
  type GenerateRequest,
  engineSandboxDir,
  flattenConversation,
} from "./types.js";

/**
 * Dùng gói ChatGPT (Plus/Pro/Business) qua Codex CLI mà chủ máy đã tự đăng nhập
 * (`codex login`, trên VPS: `codex login --device-auth`).
 * Chạy ở sandbox chỉ-đọc, không lưu phiên, không cần git repo.
 */
export class CodexEngine implements Engine {
  readonly kind = "codex" as const;
  constructor(private readonly cfg: EngineConfig) {}

  async generate(req: GenerateRequest): Promise<string> {
    const instructions = req.system ? `<vai_tro>\n${req.system}\n</vai_tro>\n\n` : "";
    const prompt = instructions + flattenConversation(req.messages);
    // --ignore-user-config: bỏ MCP/model/ghi nhớ trong ~/.codex/config.toml của chủ máy (đăng nhập vẫn giữ).
    const args = [
      "exec", "--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config",
      "--sandbox", "read-only", "--cd", engineSandboxDir(),
    ];
    if (this.cfg.model) args.push("--model", this.cfg.model);
    args.push("-"); // đọc prompt từ stdin: tránh lỗi trích dẫn và giới hạn độ dài dòng lệnh

    const stdout = await runCli(this.cfg.cliPath ?? "codex", args, prompt, {
      timeoutMs: this.cfg.timeoutMs ?? 180_000,
      signal: req.signal,
    });
    return parseCodexJsonl(stdout);
  }
}

/** Lấy tin trả lời cuối cùng từ luồng sự kiện JSONL của `codex exec --json`. */
export function parseCodexJsonl(stdout: string): string {
  let answer: string | undefined;
  let error: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    let ev: { type?: string; item?: { type?: string; text?: string }; message?: string; error?: { message?: string } };
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "item.completed" && ev.item?.type === "agent_message" && ev.item.text) answer = ev.item.text;
    if (ev.type === "error" || ev.type === "turn.failed") error = ev.message ?? ev.error?.message ?? error;
  }
  if (answer) return answer.trim();
  throw new EngineError(`Codex không trả lời${error ? `: ${error}` : ""}`, LOGIN_HINT);
}

const LOGIN_HINT =
  "Cài Codex CLI (`npm i -g @openai/codex`), chạy `codex login` (trên VPS: `codex login --device-auth`) bằng tài khoản ChatGPT rồi thử lại.";

const SAFE_ARG = /^[\p{L}\p{N} ._~\-\/\\:]+$/u;

export function runCli(
  command: string,
  args: string[],
  stdin: string,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Trên Windows, CLI cài qua npm là file .cmd → phải chạy qua shell. Shell nối chuỗi
    // không thoát ký tự, nên chỉ nhận đối số an toàn (model, đường dẫn) — chặn chèn lệnh.
    const unsafe = [command, ...args].find((a) => !SAFE_ARG.test(a));
    if (unsafe !== undefined) {
      return reject(new EngineError(`Giá trị không hợp lệ: ${JSON.stringify(unsafe)}`, "Tên model và đường dẫn chỉ gồm chữ, số, . _ - / \\ : và khoảng trắng."));
    }
    const win = process.platform === "win32";
    const child = win
      ? spawn([command, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" "), {
          shell: true,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        })
      : spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const kill = () => child.kill();
    const timer = setTimeout(kill, opts.timeoutMs);
    opts.signal?.addEventListener("abort", kill, { once: true });
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new EngineError(`Không chạy được \`${command}\`: ${e.message}`, LOGIN_HINT));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) return reject(new EngineError(`\`${command}\` bị dừng (quá thời gian hoặc bị huỷ)`));
      if (code !== 0 && !out.includes('"agent_message"')) {
        const tail = (err || out).trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 400);
        return reject(new EngineError(`\`${command}\` thoát mã ${code}: ${tail}`, LOGIN_HINT));
      }
      resolve(out);
    });
    child.stdin.end(stdin, "utf8");
  });
}
