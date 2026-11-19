-- Trợ lý CDN bản doanh nghiệp — đợt 1: công ty, thành viên, mã mời, máy đang chạy.
-- Chạy trong Supabase (SQL Editor hoặc `supabase db push`). Mọi bảng khoá bằng Row Level Security:
-- người dùng chỉ thấy công ty mình là thành viên. Tạo công ty và vào công ty chỉ đi qua hàm (RPC) bên dưới.

create extension if not exists pgcrypto;

create table public.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  created_at timestamptz not null default now()
);

create table public.members (
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('owner', 'manager', 'sales')),
  display_name text not null default '',
  email text not null default '',
  joined_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index members_user on public.members (user_id);

create table public.invites (
  code text primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  role text not null default 'sales' check (role in ('manager', 'sales')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  max_uses integer not null default 50 check (max_uses > 0),
  uses integer not null default 0,
  revoked boolean not null default false
);

-- Mỗi máy chạy app đã nối công ty: phiên bản, các nick Zalo đang chạy, lần đồng bộ cuối.
create table public.devices (
  id uuid primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null,
  name text not null default '',
  app_version text not null default '',
  nicks jsonb not null default '[]',
  last_seen timestamptz not null default now()
);
create index devices_org on public.devices (org_id);

-- ---------- Hàm hỗ trợ cho luật ----------
-- security definer + search_path cố định: đọc bảng members mà không vướng chính luật RLS của nó.
create or replace function public.my_role(p_org uuid) returns text
language sql stable security definer set search_path = public as $$
  select role from public.members where org_id = p_org and user_id = auth.uid()
$$;

create or replace function public.is_member(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where org_id = p_org and user_id = auth.uid())
$$;

create or replace function public.is_manager(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role(p_org) in ('owner', 'manager'), false)
$$;

-- ---------- Luật ----------
alter table public.orgs enable row level security;
alter table public.members enable row level security;
alter table public.invites enable row level security;
alter table public.devices enable row level security;

create policy orgs_read on public.orgs for select using (public.is_member(id));
create policy orgs_rename on public.orgs for update using (public.my_role(id) = 'owner') with check (public.my_role(id) = 'owner');

create policy members_read on public.members for select using (public.is_member(org_id));
-- Quản lý đổi vai / gỡ nhân viên (sales); chỉ chủ công ty đụng được tới quản lý. Không ai tự gỡ chủ công ty.
create policy members_manage on public.members for update
  using (public.my_role(org_id) = 'owner' or (public.my_role(org_id) = 'manager' and role = 'sales'))
  with check (role <> 'owner' and (public.my_role(org_id) = 'owner' or role = 'sales'));
create policy members_remove on public.members for delete
  using (role <> 'owner' and (public.my_role(org_id) = 'owner' or (public.my_role(org_id) = 'manager' and role = 'sales')));
-- Ai cũng sửa được tên hiển thị của chính mình (qua hàm set_display_name).

create policy invites_manage on public.invites for all using (public.is_manager(org_id)) with check (public.is_manager(org_id) and created_by = auth.uid());

create policy devices_read on public.devices for select using (public.is_member(org_id));
create policy devices_write on public.devices for insert with check (user_id = auth.uid() and public.is_member(org_id));
create policy devices_update on public.devices for update using (user_id = auth.uid()) with check (user_id = auth.uid() and public.is_member(org_id));
create policy devices_delete on public.devices for delete using (user_id = auth.uid() or public.is_manager(org_id));

-- ---------- Hàm (RPC) ----------
-- Tạo công ty: người tạo thành chủ công ty.
create or replace function public.create_org(p_name text, p_display_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_org uuid; v_email text;
begin
  if auth.uid() is null then raise exception 'Cần đăng nhập'; end if;
  select coalesce(email, '') into v_email from auth.users where id = auth.uid();
  insert into public.orgs (name) values (trim(p_name)) returning id into v_org;
  insert into public.members (org_id, user_id, role, display_name, email)
    values (v_org, auth.uid(), 'owner', coalesce(nullif(trim(p_display_name), ''), split_part(coalesce(v_email, ''), '@', 1)), coalesce(v_email, ''));
  return v_org;
end $$;

-- Tạo mã mời (quản lý trở lên). Mã ngẫu nhiên 10 ký tự, khó đoán.
create or replace function public.create_invite(p_org uuid, p_role text default 'sales', p_days integer default 14, p_max_uses integer default 50) returns text
language plpgsql security definer set search_path = public as $$
declare v_code text;
begin
  if not public.is_manager(p_org) then raise exception 'Chỉ quản lý mới tạo được mã mời'; end if;
  if p_role = 'manager' and public.my_role(p_org) <> 'owner' then raise exception 'Chỉ chủ công ty mời được quản lý'; end if;
  v_code := upper(substr(replace(encode(gen_random_bytes(12), 'base64'), '/', 'x'), 1, 10));
  v_code := replace(replace(v_code, '+', 'Z'), '=', 'Q');
  insert into public.invites (code, org_id, role, created_by, expires_at, max_uses)
    values (v_code, p_org, coalesce(p_role, 'sales'), auth.uid(), now() + make_interval(days => greatest(1, least(p_days, 90))), greatest(1, p_max_uses));
  return v_code;
end $$;

-- Vào công ty bằng mã mời. Đã là thành viên thì giữ vai cũ.
create or replace function public.join_org(p_code text, p_display_name text) returns table (org_id uuid, org_name text, role text)
language plpgsql security definer set search_path = public as $$
declare v_inv public.invites; v_email text;
begin
  if auth.uid() is null then raise exception 'Cần đăng nhập'; end if;
  select * into v_inv from public.invites where code = upper(trim(p_code)) for update;
  if not found or v_inv.revoked or v_inv.expires_at < now() or v_inv.uses >= v_inv.max_uses then
    raise exception 'Mã mời không đúng hoặc đã hết hạn';
  end if;
  select coalesce(email, '') into v_email from auth.users where id = auth.uid();
  if not exists (select 1 from public.members m where m.org_id = v_inv.org_id and m.user_id = auth.uid()) then
    insert into public.members (org_id, user_id, role, display_name, email)
      values (v_inv.org_id, auth.uid(), v_inv.role, coalesce(nullif(trim(p_display_name), ''), split_part(coalesce(v_email, ''), '@', 1)), coalesce(v_email, ''));
    update public.invites set uses = uses + 1 where code = v_inv.code;
  end if;
  return query select o.id, o.name, m.role from public.orgs o join public.members m on m.org_id = o.id and m.user_id = auth.uid() where o.id = v_inv.org_id;
end $$;

create or replace function public.set_display_name(p_org uuid, p_name text) returns void
language sql security definer set search_path = public as $$
  update public.members set display_name = left(trim(p_name), 120) where org_id = p_org and user_id = auth.uid()
$$;

-- Rời công ty (chủ công ty không tự rời được).
create or replace function public.leave_org(p_org uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.my_role(p_org) = 'owner' then raise exception 'Chủ công ty không tự rời được; chuyển quyền chủ trước'; end if;
  delete from public.devices where org_id = p_org and user_id = auth.uid();
  delete from public.members where org_id = p_org and user_id = auth.uid();
end $$;

revoke all on function public.create_org(text, text), public.create_invite(uuid, text, integer, integer), public.join_org(text, text),
  public.set_display_name(uuid, text), public.leave_org(uuid) from public;
grant execute on function public.create_org(text, text), public.create_invite(uuid, text, integer, integer), public.join_org(text, text),
  public.set_display_name(uuid, text), public.leave_org(uuid), public.my_role(uuid), public.is_member(uuid), public.is_manager(uuid) to authenticated;
grant select, update, delete on public.orgs, public.members to authenticated;
grant select, insert, update, delete on public.invites, public.devices to authenticated;
