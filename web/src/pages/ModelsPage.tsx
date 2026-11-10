import { useEffect, useState } from "react";
import { api, type CheckResult, type EngineConfigView, type EngineKind, type Preset } from "../api";

const KINDS: { kind: EngineKind; title: string; desc: string }[] = [
  {
    kind: "claude-code",
    title: "Gói Claude (Pro / Max)",
    desc: "Dùng Claude Code đã cài và đăng nhập trên máy này. Không tốn thêm tiền API.",
  },
  {
    kind: "codex",
    title: "Gói ChatGPT (Plus / Pro)",
    desc: "Dùng Codex CLI đã đăng nhập bằng tài khoản ChatGPT trên máy này.",
  },
  {
    kind: "openai-compatible",
    title: "API key: OpenAI, Gemini, OpenRouter, DeepSeek, Ollama",
    desc: "Trả tiền theo lượng dùng cho nhà cung cấp bạn chọn.",
  },
  {
    kind: "anthropic-api",
    title: "API key: Anthropic (Claude)",
    desc: "Khoá từ platform.claude.com, trả tiền theo lượng dùng. Nên dùng khi chạy cho doanh nghiệp.",
  },
];

interface Form {
  kind: EngineKind;
  model: string;
  baseUrl: string;
  cliPath: string;
  apiKey: string;
}

const EMPTY: Form = { kind: "claude-code", model: "", baseUrl: "", cliPath: "", apiKey: "" };

export function ModelsPage() {
  const [form, setForm] = useState<Form>(EMPTY);
  const [saved, setSaved] = useState<EngineConfigView | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [busy, setBusy] = useState<"" | "check" | "save">("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    api<{ config: EngineConfigView | null; presets: Preset[] }>("/api/engine").then((r) => {
      setPresets(r.presets);
      setSaved(r.config);
      if (r.config) {
        setForm({
          kind: r.config.kind,
          model: r.config.model ?? "",
          baseUrl: r.config.baseUrl ?? "",
          cliPath: r.config.cliPath ?? "",
          apiKey: "",
        });
      }
    });
  }, []);

  const set = (patch: Partial<Form>) => {
    setForm((f) => ({ ...f, ...patch }));
    setCheck(null);
    setMessage("");
  };
  const needsKey = form.kind === "openai-compatible" || form.kind === "anthropic-api";
  const isCli = form.kind === "claude-code" || form.kind === "codex";
  const keySaved = saved?.kind === form.kind && saved.hasApiKey;

  const runCheck = async () => {
    setBusy("check");
    setCheck(null);
    try {
      setCheck(await api<CheckResult>("/api/engine/check", { body: form }));
    } catch (err) {
      setCheck({ ok: false, ms: 0, error: (err as Error).message });
    } finally {
      setBusy("");
    }
  };

  const save = async () => {
    setBusy("save");
    try {
      await api("/api/engine", { method: "PUT", body: form });
      const r = await api<{ config: EngineConfigView | null }>("/api/engine");
      setSaved(r.config);
      set({ apiKey: "" });
      setMessage("Đã lưu. Trợ lý sẽ dùng mô hình này.");
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy("");
    }
  };

  return (
    <section className="stack">
      <p className="muted">Chọn "bộ não" cho trợ lý. Bấm Kiểm tra trước khi lưu.</p>

      <div className="choices">
        {KINDS.map((k) => (
          <label key={k.kind} className={form.kind === k.kind ? "choice selected" : "choice"}>
            <input type="radio" name="kind" checked={form.kind === k.kind} onChange={() => set({ kind: k.kind })} />
            <span>
              <strong>{k.title}</strong>
              <small>{k.desc}</small>
            </span>
          </label>
        ))}
      </div>

      <div className="card stack">
        {form.kind === "openai-compatible" && (
          <label>
            Nhà cung cấp
            <select
              value={presets.find((p) => p.baseUrl === form.baseUrl)?.id ?? ""}
              onChange={(e) => {
                const p = presets.find((x) => x.id === e.target.value);
                if (p) set({ baseUrl: p.baseUrl, model: p.model || form.model });
              }}
            >
              <option value="">— Tự nhập địa chỉ —</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {form.kind === "openai-compatible" && (
          <label>
            Địa chỉ API (Base URL)
            <input value={form.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://…/v1" />
          </label>
        )}
        {needsKey && (
          <label>
            API key
            <input
              type="password"
              value={form.apiKey}
              onChange={(e) => set({ apiKey: e.target.value })}
              placeholder={keySaved ? "Đã lưu — để trống nếu không đổi" : "Dán API key vào đây"}
              autoComplete="off"
            />
          </label>
        )}
        <label>
          <span>
            Tên model {form.kind !== "openai-compatible" && <span className="muted">(để trống = mặc định)</span>}
          </span>
          <input value={form.model} onChange={(e) => set({ model: e.target.value })} />
        </label>
        {isCli && (
          <details>
            <summary>Nâng cao</summary>
            <label>
              Đường dẫn tới {form.kind === "codex" ? "codex" : "claude"} (nếu không có sẵn trên PATH)
              <input value={form.cliPath} onChange={(e) => set({ cliPath: e.target.value })} />
            </label>
          </details>
        )}
        {isCli && (
          <p className="muted small">
            {form.kind === "claude-code"
              ? "Chưa đăng nhập? Mở terminal trên máy chạy app, gõ `claude` rồi làm theo hướng dẫn đăng nhập."
              : "Chưa đăng nhập? Mở terminal trên máy chạy app, gõ `codex login` (trên VPS: `codex login --device-auth`)."}
          </p>
        )}

        <div className="row">
          <button onClick={runCheck} disabled={busy !== ""}>
            {busy === "check" ? "Đang kiểm tra…" : "Kiểm tra kết nối"}
          </button>
          <button className="primary" onClick={save} disabled={busy !== ""}>
            {busy === "save" ? "Đang lưu…" : "Lưu"}
          </button>
        </div>

        {check && (
          <div className={check.ok ? "notice ok" : "notice bad"}>
            {check.ok ? (
              <>
                Chạy được ({(check.ms / 1000).toFixed(1)} giây). Mô hình trả lời: “{check.reply}”
              </>
            ) : (
              <>
                <strong>Chưa chạy được.</strong> {check.error}
                {check.hint && <div className="small">{check.hint}</div>}
              </>
            )}
          </div>
        )}
        {message && <p className="muted">{message}</p>}
      </div>
    </section>
  );
}
