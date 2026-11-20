-- Trợ lý CDN bản doanh nghiệp — siết phân quyền (chạy sau 0001).
-- 1. Mã mời chỉ tạo qua hàm create_invite (đúng luật ai mời được vai nào); quản lý chỉ được thu hồi hoặc xoá mã.
-- 2. Không ai sửa được dòng của chủ công ty; quyền chủ chỉ đổi qua hàm transfer_owner.
-- 3. Sửa thành viên chỉ đổi được vai trò; sửa công ty chỉ đổi được tên.
-- 4. Gỡ một người khỏi công ty thì máy của người đó cũng biến khỏi danh sách.

-- Mã mời
drop policy if exists invites_manage on public.invites;
create policy invites_read on public.invites for select using (public.is_manager(org_id));
create policy invites_revoke on public.invites for update using (public.is_manager(org_id)) with check (public.is_manager(org_id));
create policy invites_delete on public.invites for delete using (public.is_manager(org_id));

-- Thành viên: chỉ đổi vai, không đụng dòng chủ công ty
drop policy if exists members_manage on public.members;
create policy members_manage on public.members for update
  using (role <> 'owner' and (public.my_role(org_id) = 'owner' or (public.my_role(org_id) = 'manager' and role = 'sales')))
  with check (role <> 'owner' and (public.my_role(org_id) = 'owner' or role = 'sales'));

-- Quyền trên bảng: thu hết rồi cấp đúng phần cần (Supabase mặc định cấp mọi quyền cho authenticated).
-- Công ty chỉ đổi tên; thành viên chỉ đổi vai; mã mời chỉ thu hồi; máy thì người dùng tự ghi máy của mình (luật RLS ở 0001).
revoke all on public.orgs, public.members, public.invites, public.devices from authenticated, anon;
grant select, update (name) on public.orgs to authenticated;
grant select, delete, update (role) on public.members to authenticated;
grant select, delete, update (revoked) on public.invites to authenticated;
grant select, insert, update, delete on public.devices to authenticated;

-- Chuyển quyền chủ công ty cho một thành viên khác; chủ cũ thành quản lý.
create or replace function public.transfer_owner(p_org uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.my_role(p_org) is distinct from 'owner' then raise exception 'Chỉ chủ công ty mới chuyển được quyền chủ'; end if;
  if p_user = auth.uid() then raise exception 'Bạn đang là chủ công ty'; end if;
  if not exists (select 1 from public.members where org_id = p_org and user_id = p_user) then raise exception 'Người này không thuộc công ty'; end if;
  update public.members set role = 'manager' where org_id = p_org and user_id = auth.uid();
  update public.members set role = 'owner' where org_id = p_org and user_id = p_user;
end $$;
revoke all on function public.transfer_owner(uuid, uuid) from public, anon;
grant execute on function public.transfer_owner(uuid, uuid) to authenticated;

-- Gỡ thành viên → xoá máy của họ trong công ty đó
create or replace function public.members_cleanup_devices() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.devices where org_id = old.org_id and user_id = old.user_id;
  return old;
end $$;
drop trigger if exists members_cleanup_devices on public.members;
create trigger members_cleanup_devices after delete on public.members for each row execute function public.members_cleanup_devices();
