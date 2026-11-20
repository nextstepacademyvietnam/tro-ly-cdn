"use client";
import { type FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

/** Đăng nhập bằng mã 6 số gửi qua email (không mật khẩu). */
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const send = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { error } = await supabase().auth.signInWithOtp({ email: email.trim().toLowerCase(), options: { shouldCreateUser: true } });
    setBusy(false);
    if (error) setError(error.message);
    else setSent(true);
  };
  const verify = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { error } = await supabase().auth.verifyOtp({ email: email.trim().toLowerCase(), token: token.trim(), type: "email" });
    setBusy(false);
    if (error) setError("Mã không đúng hoặc đã hết hạn");
    else router.replace("/");
  };

  return (
    <div className="auth">
      <div className="card">
        <h1>Trợ lý CDN · Quản lý</h1>
        <p className="muted small">Trang của chủ công ty và quản lý: mời nhân viên, phân vai, xem máy và nick Zalo đang chạy app. Đăng nhập bằng mã gửi qua email, không cần mật khẩu.</p>
        {!sent ? (
          <form className="stack" onSubmit={send}>
            <label className="field">
              <span>Email</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ten@congty.vn" autoComplete="email" required />
            </label>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? "Đang gửi…" : "Gửi mã đăng nhập"}
            </button>
          </form>
        ) : (
          <form className="stack" onSubmit={verify}>
            <p className="small">
              Đã gửi mã tới <b>{email}</b>. Mở email (xem cả mục Spam), nhập mã ở đây.
            </p>
            <label className="field">
              <span>Mã đăng nhập</span>
              <input value={token} onChange={(e) => setToken(e.target.value)} inputMode="numeric" autoComplete="one-time-code" autoFocus required />
            </label>
            <div className="row">
              <button type="submit" className="primary" disabled={busy}>
                {busy ? "Đang vào…" : "Đăng nhập"}
              </button>
              <button type="button" className="link" onClick={() => setSent(false)}>
                Đổi email
              </button>
            </div>
          </form>
        )}
        {error && <div className="notice bad">{error}</div>}
      </div>
    </div>
  );
}
