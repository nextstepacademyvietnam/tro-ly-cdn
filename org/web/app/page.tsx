"use client";
import { useEffect, useState } from "react";
import { Shell, useOrg } from "@/lib/shell";
import { supabase, timeAgo } from "@/lib/supabase";

interface Device {
  id: string;
  user_id: string;
  name: string;
  app_version: string;
  nicks: { name: string; state: string }[];
  last_seen: string;
}

/** Tổng quan (đợt 1): số thành viên, máy đang chạy app, nick Zalo đang kết nối. Số liệu phòng có ở đợt 3. */
function Overview() {
  const { member } = useOrg();
  const [members, setMembers] = useState<{ user_id: string; display_name: string; email: string }[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  useEffect(() => {
    void supabase().from("members").select("user_id, display_name, email").eq("org_id", member.org_id).then(({ data }) => setMembers(data ?? []));
    void supabase().from("devices").select("*").eq("org_id", member.org_id).order("last_seen", { ascending: false }).then(({ data }) => setDevices((data ?? []) as Device[]));
  }, [member.org_id]);
  const online = (d: Device) => Date.now() - Date.parse(d.last_seen) < 15 * 60_000;
  const who = (id: string) => members.find((m) => m.user_id === id)?.display_name || members.find((m) => m.user_id === id)?.email || "—";
  const nicksOn = devices.filter(online).flatMap((d) => d.nicks.filter((n) => n.state === "connected")).length;

  return (
    <div className="stack">
      <div className="head">
        <h1>Tổng quan</h1>
      </div>
      <div className="grid2">
        <div className="stat">
          <span className="muted small">Thành viên</span>
          <b>{members.length}</b>
        </div>
        <div className="stat">
          <span className="muted small">Máy đang chạy app</span>
          <b>
            {devices.filter(online).length} / {devices.length}
          </b>
        </div>
        <div className="stat">
          <span className="muted small">Nick Zalo đang kết nối</span>
          <b>{nicksOn}</b>
        </div>
      </div>
      <div className="card">
        <h2>Máy đang chạy app</h2>
        {devices.length === 0 ? (
          <p className="muted small">Chưa có máy nào nối. Vào Thành viên tạo mã kết nối, gửi cho nhân viên nhập trong app trên máy họ.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Người dùng</th>
                  <th>Máy</th>
                  <th>Nick Zalo</th>
                  <th>Bản app</th>
                  <th>Lần cuối</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.id}>
                    <td>{who(d.user_id)}</td>
                    <td>{d.name || "—"}</td>
                    <td>
                      {d.nicks.length
                        ? d.nicks.map((n) => (
                            <span key={n.name} className={n.state === "connected" && online(d) ? "badge ok" : "badge"} style={{ marginRight: 4 }}>
                              {n.name}
                            </span>
                          ))
                        : "—"}
                    </td>
                    <td>{d.app_version || "—"}</td>
                    <td>
                      <span className={online(d) ? "badge ok" : "badge off"}>{online(d) ? "Đang chạy" : timeAgo(d.last_seen)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="muted small">Kiến thức dùng chung, số liệu phòng kinh doanh và giao khách sẽ có ở các đợt tiếp theo.</p>
    </div>
  );
}

export default function Page() {
  return (
    <Shell>
      <Overview />
    </Shell>
  );
}
