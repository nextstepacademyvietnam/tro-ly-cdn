import { useState, type FormEvent } from "react";
import { api } from "../api";

export function AuthScreen({ firstRun, onDone }: { firstRun: boolean; onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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
      </form>
    </div>
  );
}
