import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";

type Status = { platform?: string; installKind?: "launcher" | "git" | "folder" };

/** Cách đặt lại mật khẩu ngay trên máy cài app, theo hệ điều hành và cách cài. */
function ResetHelp({ status }: { status: Status }) {
  const { platform = "", installKind = "folder" } = status;
  let steps: React.ReactNode;
  if (installKind !== "launcher") {
    steps = (
      <>
        <p>Mở cửa sổ lệnh trong thư mục app (nơi có file package.json) rồi chạy:</p>
        <pre className="doc-text auth-cmd">npm run reset-password</pre>
      </>
    );
  } else if (platform === "win32") {
    steps = (
      <ol>
        <li>
          Bấm nút Start, gõ <b>Đặt lại mật khẩu Trợ lý CDN</b> rồi bấm Enter.
        </li>
        <li>Cửa sổ hiện tên đăng nhập và mật khẩu mới. Ghi lại rồi đăng nhập ở đây.</li>
      </ol>
    );
  } else if (platform === "darwin") {
    steps = (
      <>
        <p>Mở Terminal (Command + phím cách, gõ Terminal), dán lệnh này rồi bấm Enter:</p>
        <pre className="doc-text auth-cmd">bash ~/Library/Application\ Support/TroLyCDN/dat-lai-mat-khau.sh</pre>
        <p>Terminal hiện tên đăng nhập và mật khẩu mới.</p>
      </>
    );
  } else {
    steps = (
      <>
        <p>Trên máy chủ (VPS) chạy:</p>
        <pre className="doc-text auth-cmd">bash ~/.tro-ly-cdn/dat-lai-mat-khau.sh</pre>
      </>
    );
  }
  return (
    <div className="auth-help small">
      <strong>Quên mật khẩu?</strong>
      <p className="muted">Mật khẩu chỉ đặt lại được trên chính máy đang chạy app, để người khác không chiếm được nick Zalo của bạn. Dữ liệu giữ nguyên.</p>
      {steps}
    </div>
  );
}

export function AuthScreen({ firstRun, onDone }: { firstRun: boolean; onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [status, setStatus] = useState<Status>({});
  useEffect(() => {
    api<Status>("/api/status").then(setStatus).catch(() => undefined);
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (firstRun && password !== confirm) return setError("Hai lần nhập mật khẩu không khớp");
    setBusy(true);
    try {
      await api(firstRun ? "/api/setup" : "/api/login", { body: { username, password } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center">
      <form className="card auth" onSubmit={submit}>
        <h1>Trợ lý CDN</h1>
        <p className="muted">
          {firstRun
            ? "Lần đầu mở app: tạo tài khoản quản trị. Chỉ người có tài khoản này mới vào được trang quản lý."
            : "Đăng nhập để quản lý trợ lý."}
        </p>
        <label>
          Tên đăng nhập
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          Mật khẩu
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={firstRun ? "new-password" : "current-password"}
            required
          />
        </label>
        {firstRun && (
          <label>
            Nhập lại mật khẩu
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>
          {busy ? "Đang xử lý…" : firstRun ? "Tạo tài khoản" : "Đăng nhập"}
        </button>
        {!firstRun && (
          <button type="button" className="link auth-forgot" aria-expanded={forgot} onClick={() => setForgot((v) => !v)}>
            Quên mật khẩu?
          </button>
        )}
        {!firstRun && forgot && <ResetHelp status={status} />}
      </form>
    </div>
  );
}
