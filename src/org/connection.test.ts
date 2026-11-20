import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDb } from "../server/db.js";
import { SecretBox } from "../server/secrets.js";
import { Settings } from "../server/settings.js";
import { OrgConnection, makeConnectCode, parseConnectCode } from "./connection.js";

const CODE = makeConnectCode({ url: "https://abc.supabase.co", anonKey: "anon-key", invite: "MOI123", orgName: "Next Step Group" });

/** Supabase giả: đủ các hàm OrgConnection dùng, ghi lại mọi lời gọi. */
function fakeSupabase() {
  const calls: string[] = [];
  const devices = new Map<string, Record<string, unknown>>();
  let session: { refresh_token: string; expires_at: number } | null = null;
  let member: { role: string; display_name: string } | null = { role: "sales", display_name: "Hưng" };
  const client = {
    auth: {
      signInWithOtp: async ({ email }: { email: string }) => (calls.push(`otp:${email}`), { error: null }),
      verifyOtp: async ({ token }: { token: string }) => {
        calls.push(`verify:${token}`);
        if (token !== "123456") return { data: { session: null, user: null }, error: { message: "Token has expired or is invalid" } };
        session = { refresh_token: "r1", expires_at: Math.floor(Date.now() / 1000) + 3600 };
        return { data: { session, user: { id: "u1" } }, error: null };
      },
      getSession: async () => ({ data: { session } }),
      refreshSession: async ({ refresh_token }: { refresh_token: string }) => {
        calls.push(`refresh:${refresh_token}`);
        session = { refresh_token: "r2", expires_at: Math.floor(Date.now() / 1000) + 3600 };
        return { data: { session }, error: null };
      },
      signOut: async () => (calls.push("signout"), { error: null }),
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push(`rpc:${fn}:${args.p_code}`);
      return { data: [{ org_id: "o1", org_name: "Next Step Group", role: "sales" }], error: null };
    },
    from: (table: string) => ({
      upsert: async (row: Record<string, unknown>) => (devices.set(String(row.id), row), calls.push(`upsert:${table}`), { error: null }),
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: member }) }) }) }),
      delete: () => ({ eq: async (_k: string, v: string) => (devices.delete(v), calls.push(`delete:${table}`), { error: null }) }),
    }),
  };
  return { client, calls, devices, dropSession: () => (session = null), kick: () => (member = null) };
}

function setup() {
  const db = openDb(":memory:");
  const settings = new Settings(db, new SecretBox(crypto.randomBytes(32)));
  const sb = fakeSupabase();
  const org = new OrgConnection({ settings, version: "0.3.0", nicks: () => [{ name: "Bot Hiếu", state: "connected" }], client: () => sb.client as never });
  return { db, settings, sb, org };
}

describe("kết nối doanh nghiệp", () => {
  it("đọc mã kết nối; mã sai thì báo dễ hiểu", () => {
    expect(parseConnectCode(` ${CODE} `)).toEqual({ url: "https://abc.supabase.co", anonKey: "anon-key", invite: "MOI123", orgName: "Next Step Group" });
    expect(() => parseConnectCode("abc")).toThrow(/CDN1/);
    expect(() => parseConnectCode("CDN1.xxx")).toThrow();
  });

  it("dán mã + email → mã xác nhận; nhập đúng → vào công ty, ghi máy; phiên lưu mã hoá", async () => {
    const t = setup();
    expect(t.org.status().connected).toBe(false);
    await expect(t.org.begin(CODE, "sai-email")).rejects.toThrow(/Email/);
    await t.org.begin(CODE, "Hung@NSG.vn");
    expect(t.org.status()).toMatchObject({ pendingEmail: "hung@nsg.vn", pendingOrg: "Next Step Group" });
    await expect(t.org.verify("000000", "Hưng")).rejects.toThrow(/không đúng/);
    const s = await t.org.verify("123456", "Hưng");
    expect(s).toMatchObject({ connected: true, orgName: "Next Step Group", role: "sales", email: "hung@nsg.vn", error: "" });
    expect(t.sb.calls).toContain("rpc:join_org:MOI123");
    const dev = [...t.sb.devices.values()][0]!;
    expect(dev).toMatchObject({ org_id: "o1", user_id: "u1", app_version: "0.3.0", nicks: [{ name: "Bot Hiếu", state: "connected" }] });
    const raw = JSON.stringify(t.db.prepare("SELECT value FROM settings WHERE key = 'org.connection'").get());
    expect(raw).not.toContain("r1");
    t.org.stop();
  });

  it("phiên hết hạn thì tự làm mới bằng refresh token; bị gỡ khỏi công ty thì báo; ngắt kết nối thì xoá trên máy", async () => {
    const t = setup();
    await t.org.begin(CODE, "hung@nsg.vn");
    await t.org.verify("123456", "Hưng");
    t.sb.dropSession();
    await t.org.heartbeat();
    expect(t.sb.calls).toContain("refresh:r1");
    t.sb.dropSession();
    await t.org.heartbeat();
    expect(t.sb.calls).toContain("refresh:r2");
    t.sb.kick();
    await t.org.heartbeat();
    expect(t.org.status().error).toMatch(/không còn trong công ty/);
    await t.org.disconnect();
    expect(t.org.status().connected).toBe(false);
    expect(t.sb.devices.size).toBe(0);
    expect(t.sb.calls).toContain("signout");
  });
});
