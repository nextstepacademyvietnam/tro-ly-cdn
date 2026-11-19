"use client";
import { type SupabaseClient, createClient } from "@supabase/supabase-js";

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

let client: SupabaseClient | null = null;

/** Client Supabase dùng trong trình duyệt (anon key + phiên người dùng; quyền do RLS quyết định). */
export function supabase(): SupabaseClient {
  if (!client) client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
  return client;
}

export type Role = "owner" | "manager" | "sales";
export interface Membership {
  org_id: string;
  role: Role;
  display_name: string;
  orgs: { id: string; name: string } | null;
}

export const ROLE_LABEL: Record<Role, string> = { owner: "Chủ công ty", manager: "Quản lý", sales: "Nhân viên kinh doanh" };

/**
 * Mã kết nối cho app trên máy nhân viên: "CDN1." + base64url của { u, k, c, n }. Cùng định dạng với
 * src/org/connection.ts (makeConnectCode / parseConnectCode) của app.
 */
export function connectCode(invite: string, orgName: string): string {
  const json = JSON.stringify({ u: SUPABASE_URL.replace(/\/$/, ""), k: SUPABASE_ANON_KEY, c: invite, n: orgName });
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `CDN1.${b64}`;
}

export const timeAgo = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (m < 1) return "vừa xong";
  if (m < 60) return `${m} phút trước`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} giờ trước`;
  return `${Math.round(h / 24)} ngày trước`;
};
