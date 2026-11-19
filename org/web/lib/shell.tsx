"use client";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type Membership, ROLE_LABEL, supabase } from "./supabase";

interface OrgCtx {
  userId: string;
  email: string;
  member: Membership;
  reload: () => void;
}
const Ctx = createContext<OrgCtx | null>(null);
export const useOrg = () => useContext(Ctx)!;

/** Khung trang quản lý: bắt đăng nhập, lấy công ty của người dùng; chưa có công ty thì cho tạo. */
export function Shell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const [state, setState] = useState<{ userId: string; email: string; members: Membership[] } | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const { data } = await supabase().auth.getSession();
    if (!data.session) return router.replace("/dang-nhap");
    const { data: rows, error } = await supabase().from("members").select("org_id, role, display_name, orgs(id, name)").eq("user_id", data.session.user.id);
    if (error) return setError(error.message);
    setState({ userId: data.session.user.id, email: data.session.user.email ?? "", members: (rows ?? []) as unknown as Membership[] });
  }, [router]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <div className="auth"><div className="notice bad">{error}</div></div>;
  if (!state) return null;
  if (!state.members.length) return <CreateOrg email={state.email} onDone={load} />;
  const member = state.members[0]!;
  const nav = (href: string, label: string) => (
    <Link href={href} className={path === href ? "nav on" : "nav"}>
      {label}
    </Link>
  );
  return (
    <Ctx.Provider value={{ userId: state.userId, email: state.email, member, reload: load }}>
      <div className="shell">
        <aside className="side">
          <div className="brand">
            <i aria-hidden /> {member.orgs?.name ?? "Công ty"}
          </div>
          {nav("/", "Tổng quan")}
          {nav("/thanh-vien", "Thành viên")}
          <div className="side-foot small">
            <span className="muted">
              {member.display_name || state.email} · {ROLE_LABEL[member.role]}
            </span>
            <button type="button" className="link" onClick={() => supabase().auth.signOut().then(() => router.replace("/dang-nhap"))}>
              Đăng xuất
            </button>
          </div>
        </aside>
        <main className="main">{children}</main>
      </div>
    </Ctx.Provider>
  );
}

function CreateOrg({ email, onDone }: { email: string; onDone: () => void }) {
  const [name, setName] = useState("");
  const [me, setMe] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="auth">
      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const { error } = await supabase().rpc("create_org", { p_name: name, p_display_name: me });
          setBusy(false);
          if (error) setError(error.message);
          else onDone();
        }}
      >
        <h1>Tạo công ty</h1>
        <p className="muted small">
          {email} chưa thuộc công ty nào. Tạo công ty để làm chủ, rồi mời nhân viên. Nếu bạn là nhân viên, hãy xin quản lý mã kết nối và nhập trong app
          Trợ lý CDN trên máy (Cài đặt → Doanh nghiệp), không cần tạo ở đây.
        </p>
        <label className="field">
          <span>Tên công ty</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="VD: Next Step Group" required />
        </label>
        <label className="field">
          <span>Tên hiển thị của bạn</span>
          <input value={me} onChange={(e) => setMe(e.target.value)} placeholder="VD: Thảo" />
        </label>
        <button type="submit" className="primary" disabled={busy || !name.trim()}>
          {busy ? "Đang tạo…" : "Tạo công ty"}
        </button>
        {error && <div className="notice bad">{error}</div>}
      </form>
    </div>
  );
}
