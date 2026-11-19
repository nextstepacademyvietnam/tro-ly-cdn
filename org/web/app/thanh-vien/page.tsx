"use client";
import { useCallback, useEffect, useState } from "react";
import { Shell, useOrg } from "@/lib/shell";
import { ROLE_LABEL, type Role, connectCode, supabase, timeAgo } from "@/lib/supabase";

interface Member {
  user_id: string;
  role: Role;
  display_name: string;
  email: string;
  joined_at: string;
}
interface Invite {
  code: string;
  role: Role;
  expires_at: string;
  max_uses: number;
  uses: number;
  revoked: boolean;
}

/** Thành viên: danh sách, đổi vai, gỡ người nghỉ; tạo mã kết nối cho nhân viên nhập vào app trên máy. */
function Members() {
  const { member, userId } = useOrg();
  const org = member.org_id;
  const isManager = member.role === "owner" || member.role === "manager";
  const [list, setList] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [newRole, setNewRole] = useState<Role>("sales");
  const [shown, setShown] = useState<{ code: string; text: string } | null>(null);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const { data } = await supabase().from("members").select("user_id, role, display_name, email, joined_at").eq("org_id", org).order("joined_at");
    setList((data ?? []) as Member[]);
    if (isManager) {
      const { data: inv } = await supabase().from("invites").select("*").eq("org_id", org).order("created_at", { ascending: false });
      setInvites((inv ?? []) as Invite[]);
    }
  }, [org, isManager]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (p: PromiseLike<{ error: { message: string } | null }>, ok?: string) => {
    setError("");
    setMsg("");
    const { error } = await p;
    if (error) setError(error.message);
    else if (ok) setMsg(ok);
    await load();
  };
  const create = async () => {
    setError("");
    const { data, error } = await supabase().rpc("create_invite", { p_org: org, p_role: newRole });
    if (error) return setError(error.message);
    const code = String(data);
    setShown({ code, text: connectCode(code, member.orgs?.name ?? "") });
    await load();
  };
  const canEdit = (m: Member) => m.user_id !== userId && m.role !== "owner" && (member.role === "owner" || (member.role === "manager" && m.role === "sales"));
  const active = invites.filter((i) => !i.revoked && Date.parse(i.expires_at) > Date.now() && i.uses < i.max_uses);

  return (
    <div className="stack">
      <div className="head">
        <h1>Thành viên</h1>
      </div>
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tên</th>
                <th>Email</th>
                <th>Vai trò</th>
                <th>Vào từ</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((m) => (
                <tr key={m.user_id}>
                  <td>{m.display_name || "—"}</td>
                  <td>{m.email}</td>
                  <td>
                    {canEdit(m) && member.role === "owner" ? (
                      <select
                        value={m.role}
                        onChange={(e) => act(supabase().from("members").update({ role: e.target.value }).eq("org_id", org).eq("user_id", m.user_id), "Đã đổi vai trò.")}
                      >
                        <option value="manager">{ROLE_LABEL.manager}</option>
                        <option value="sales">{ROLE_LABEL.sales}</option>
                      </select>
                    ) : (
                      ROLE_LABEL[m.role]
                    )}
                  </td>
                  <td className="muted">{new Date(m.joined_at).toLocaleDateString("vi-VN")}</td>
                  <td>
                    {canEdit(m) && (
                      <button
                        type="button"
                        className="link danger"
                        onClick={() =>
                          confirm(`Gỡ ${m.display_name || m.email} khỏi công ty? Máy của họ sẽ không đồng bộ nữa.`) &&
                          act(supabase().from("members").delete().eq("org_id", org).eq("user_id", m.user_id), "Đã gỡ.")
                        }
                      >
                        Gỡ
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {isManager && (
        <div className="card">
          <h2>Mời nhân viên</h2>
          <p className="muted small">
            Tạo mã kết nối, gửi cho nhân viên (Zalo, email). Họ mở app Trợ lý CDN trên máy mình → <b>Cài đặt → Doanh nghiệp</b> → dán mã, nhập email, nhập
            mã xác nhận gửi về email. Một mã dùng được cho nhiều người trong 14 ngày.
          </p>
          <div className="row">
            <select value={newRole} onChange={(e) => setNewRole(e.target.value as Role)}>
              <option value="sales">{ROLE_LABEL.sales}</option>
              {member.role === "owner" && <option value="manager">{ROLE_LABEL.manager}</option>}
            </select>
            <button type="button" className="primary" onClick={create}>
              Tạo mã kết nối
            </button>
          </div>
          {shown && (
            <div className="stack">
              <div className="code">{shown.text}</div>
              <div className="row">
                <button type="button" onClick={() => navigator.clipboard.writeText(shown.text).then(() => setMsg("Đã chép mã kết nối."))}>
                  Chép mã
                </button>
                <span className="muted small">Mã mời {shown.code}</span>
              </div>
            </div>
          )}
          {active.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Mã mời</th>
                    <th>Vai trò</th>
                    <th>Đã dùng</th>
                    <th>Hết hạn</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {active.map((i) => (
                    <tr key={i.code}>
                      <td>{i.code}</td>
                      <td>{ROLE_LABEL[i.role]}</td>
                      <td>
                        {i.uses}/{i.max_uses}
                      </td>
                      <td className="muted">{timeAgo(i.expires_at).replace("trước", "nữa").replace("vừa xong", "sắp hết")}</td>
                      <td>
                        <button type="button" className="link" onClick={() => setShown({ code: i.code, text: connectCode(i.code, member.orgs?.name ?? "") })}>
                          Xem mã
                        </button>{" "}
                        <button type="button" className="link danger" onClick={() => act(supabase().from("invites").update({ revoked: true }).eq("code", i.code), "Đã thu hồi mã.")}>
                          Thu hồi
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {msg && <div className="notice ok">{msg}</div>}
      {error && <div className="notice bad">{error}</div>}
    </div>
  );
}

export default function Page() {
  return (
    <Shell>
      <Members />
    </Shell>
  );
}
