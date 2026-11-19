import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

/**
 * Chạy đúng file migration Supabase trên PGlite (Postgres trong Node) với phần đăng nhập của Supabase giả lập
 * (schema auth, auth.uid(), vai authenticated) để kiểm luật RLS mà không cần project Supabase thật.
 */
const MIGRATIONS = path.resolve("org/supabase/migrations");

async function setup() {
  const db = await PGlite.create({ extensions: { pgcrypto } });
  await db.exec(`
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create role authenticated;
    grant usage on schema public, auth to authenticated;
    grant select on auth.users to authenticated;
  `);
  for (const f of fs.readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) await db.exec(fs.readFileSync(path.join(MIGRATIONS, f), "utf8"));
  const users = { chu: crypto.randomUUID(), ql: crypto.randomUUID(), nv: crypto.randomUUID(), nv2: crypto.randomUUID(), khac: crypto.randomUUID() };
  for (const [k, id] of Object.entries(users)) await db.query("insert into auth.users values ($1, $2)", [id, `${k}@vd.vn`]);
  /** Chạy câu lệnh với tư cách một người dùng đã đăng nhập (RLS áp dụng). */
  const as = async <T = Record<string, unknown>>(who: keyof typeof users, sql: string, params: unknown[] = []) => {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${users[who]}', false); set role authenticated;`);
    try {
      return (await db.query<T>(sql, params)).rows;
    } finally {
      await db.exec("reset role;");
    }
  };
  return { db, users, as };
}

describe("RLS bản doanh nghiệp", () => {
  it("tạo công ty, mời, vào công ty; công ty khác không thấy nhau", async () => {
    const { as, users } = await setup();
    const [{ id: org }] = await as<{ id: string }>("chu", "select public.create_org('Next Step Group', 'Thảo') as id");
    const [{ code }] = await as<{ code: string }>("chu", "select public.create_invite($1, 'sales') as code", [org]);
    expect(code).toMatch(/^[A-Z0-9a-zQx]{10}$/i);
    const joined = await as("nv", "select * from public.join_org($1, 'Hưng')", [code.toLowerCase()]);
    expect(joined[0]).toMatchObject({ org_name: "Next Step Group", role: "sales" });
    // Vào lại không tăng lượt dùng, không đổi vai.
    await as("nv", "select * from public.join_org($1, 'Hưng')", [code]);
    expect((await as<{ uses: number }>("chu", "select uses from public.invites"))[0]!.uses).toBe(1);

    const [{ id: org2 }] = await as<{ id: string }>("khac", "select public.create_org('Công ty khác', '') as id");
    expect(await as("nv", "select * from public.orgs where id = $1", [org2])).toHaveLength(0);
    expect(await as("khac", "select * from public.members where org_id = $1", [org])).toHaveLength(0);
    expect((await as("nv", "select user_id from public.members order by role")).map((r) => r.user_id).sort()).toEqual([users.chu, users.nv].sort());
  });

  it("nhân viên không tạo được mã mời, không tự lên quản lý, không gỡ được ai; quản lý gỡ được nhân viên, không đụng chủ", async () => {
    const { as, users } = await setup();
    const [{ id: org }] = await as<{ id: string }>("chu", "select public.create_org('NSG', '') as id");
    const [{ code: qlCode }] = await as<{ code: string }>("chu", "select public.create_invite($1, 'manager') as code", [org]);
    const [{ code }] = await as<{ code: string }>("chu", "select public.create_invite($1, 'sales') as code", [org]);
    await as("ql", "select * from public.join_org($1, '')", [qlCode]);
    await as("nv", "select * from public.join_org($1, '')", [code]);
    await as("nv2", "select * from public.join_org($1, '')", [code]);

    await expect(as("nv", "select public.create_invite($1, 'sales')", [org])).rejects.toThrow(/quản lý/);
    await expect(as("ql", "select public.create_invite($1, 'manager')", [org])).rejects.toThrow(/chủ công ty/);
    await as("nv", "update public.members set role = 'manager' where user_id = $1", [users.nv]);
    await as("nv", "delete from public.members where user_id = $1", [users.nv2]);
    expect((await as<{ role: string }>("chu", "select role from public.members where user_id = $1", [users.nv]))[0]!.role).toBe("sales");
    expect(await as("chu", "select 1 from public.members where user_id = $1", [users.nv2])).toHaveLength(1);

    await as("ql", "delete from public.members where user_id = $1", [users.chu]);
    await expect(as("ql", "update public.members set role = 'manager' where user_id = $1", [users.nv])).rejects.toThrow(/row-level security/);
    expect(await as("chu", "select 1 from public.members where user_id = $1", [users.chu])).toHaveLength(1);
    expect((await as<{ role: string }>("chu", "select role from public.members where user_id = $1", [users.nv]))[0]!.role).toBe("sales");
    await as("ql", "delete from public.members where user_id = $1", [users.nv2]);
    expect(await as("chu", "select 1 from public.members where user_id = $1", [users.nv2])).toHaveLength(0);
    await expect(as("chu", "select public.leave_org($1)", [org])).rejects.toThrow(/Chủ công ty/);
  });

  it("máy chạy app: mỗi người chỉ ghi máy của mình; mã mời hết hạn / thu hồi thì không vào được", async () => {
    const { as, db, users } = await setup();
    const [{ id: org }] = await as<{ id: string }>("chu", "select public.create_org('NSG', '') as id");
    const [{ code }] = await as<{ code: string }>("chu", "select public.create_invite($1, 'sales') as code", [org]);
    await as("nv", "select * from public.join_org($1, '')", [code]);
    const dev = crypto.randomUUID();
    await as("nv", "insert into public.devices (id, org_id, user_id, name) values ($1, $2, $3, 'Laptop Hưng')", [dev, org, users.nv]);
    await expect(as("nv", "insert into public.devices (id, org_id, user_id) values ($1, $2, $3)", [crypto.randomUUID(), org, users.chu])).rejects.toThrow();
    await as("chu", "update public.devices set name = 'đổi' where id = $1", [dev]);
    expect((await as<{ name: string }>("chu", "select name from public.devices where id = $1", [dev]))[0]!.name).toBe("Laptop Hưng");

    await as("chu", "update public.invites set revoked = true where code = $1", [code]);
    await expect(as("nv2", "select * from public.join_org($1, '')", [code])).rejects.toThrow(/hết hạn/);
    const [{ code: c2 }] = await as<{ code: string }>("chu", "select public.create_invite($1, 'sales') as code", [org]);
    await db.query("update public.invites set expires_at = now() - interval '1 day' where code = $1", [c2]);
    await expect(as("nv2", "select * from public.join_org($1, '')", [c2])).rejects.toThrow(/hết hạn/);
    await expect(as("khac", "select * from public.join_org('KHONGCO', '')")).rejects.toThrow(/không đúng/);
  });
});
