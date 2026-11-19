import crypto from "node:crypto";
import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import type { Settings } from "../server/settings.js";

/** Mã kết nối trang quản lý tạo ra cho nhân viên: "CDN1." + base64url của { u: Supabase URL, k: anon key, c: mã mời, n: tên công ty }. */
export interface ConnectCode {
  url: string;
  anonKey: string;
  invite: string;
  orgName: string;
}

export function parseConnectCode(raw: string): ConnectCode {
  const t = raw.trim().replace(/\s+/g, "");
  if (!t.startsWith("CDN1.")) throw new Error("Mã kết nối không đúng (phải bắt đầu bằng CDN1.)");
  let j: { u?: string; k?: string; c?: string; n?: string };
  try {
    j = JSON.parse(Buffer.from(t.slice(5), "base64url").toString("utf8"));
  } catch {
    throw new Error("Mã kết nối bị thiếu hoặc sai, hãy chép lại cả đoạn");
  }
  if (!j.u || !/^https:\/\/[^/]+$/.test(j.u.replace(/\/$/, "")) || !j.k || !j.c) throw new Error("Mã kết nối thiếu thông tin, hãy xin quản lý mã mới");
  return { url: j.u.replace(/\/$/, ""), anonKey: j.k, invite: j.c, orgName: j.n ?? "" };
}

export function makeConnectCode(c: ConnectCode): string {
  return `CDN1.${Buffer.from(JSON.stringify({ u: c.url, k: c.anonKey, c: c.invite, n: c.orgName })).toString("base64url")}`;
}

/** Thông tin đã nối, lưu mã hoá trong settings (refresh token là thứ cần giữ kín). */
interface Saved {
  url: string;
  anonKey: string;
  orgId: string;
  orgName: string;
  role: "owner" | "manager" | "sales";
  email: string;
  userId: string;
  deviceId: string;
  displayName: string;
  refreshToken: string;
}

const KEY = "org.connection";
const HEARTBEAT_MS = 5 * 60_000;

export interface OrgStatus {
  connected: boolean;
  orgName: string;
  role: string;
  email: string;
  displayName: string;
  lastSync: number;
  error: string;
  /** Đang chờ nhập mã xác nhận gửi tới email này. */
  pendingEmail: string;
  pendingOrg: string;
}

export interface OrgDeps {
  settings: Settings;
  version: string;
  /** Các nick Zalo đang chạy trên máy (tên, trạng thái) để trang quản lý thấy. */
  nicks(): { name: string; state: string }[];
  deviceName?: string;
  /** Tạo client Supabase (test thay bằng client giả). */
  client?: (url: string, anonKey: string) => SupabaseClient;
  now?: () => number;
  log?: (msg: string, extra?: object) => void;
}

/**
 * Kết nối doanh nghiệp: nối app trên máy này với công ty trên Supabase (mã mời + đăng nhập bằng mã gửi qua email).
 * Chưa nối thì app là bản cá nhân như cũ. Đã nối thì 5 phút báo "máy còn chạy" một lần (phiên bản, nick Zalo).
 * Tin nhắn khách không bao giờ đi qua đây.
 */
export class OrgConnection {
  private readonly now: () => number;
  private pending: { code: ConnectCode; email: string; client: SupabaseClient } | null = null;
  private live: SupabaseClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastSync = 0;
  private error = "";

  constructor(private readonly d: OrgDeps) {
    this.now = d.now ?? Date.now;
  }

  private make(url: string, key: string): SupabaseClient {
    return (this.d.client ?? ((u, k) => createClient(u, k, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })))(url, key);
  }

  private saved(): Saved | undefined {
    return this.d.settings.getSecret<Saved>(KEY);
  }

  status(): OrgStatus {
    const s = this.saved();
    return {
      connected: Boolean(s),
      orgName: s?.orgName ?? "",
      role: s?.role ?? "",
      email: s?.email ?? "",
      displayName: s?.displayName ?? "",
      lastSync: this.lastSync,
      error: this.error,
      pendingEmail: this.pending?.email ?? "",
      pendingOrg: this.pending?.code.orgName ?? "",
    };
  }

  /** Bước 1: dán mã kết nối + email → Supabase gửi mã xác nhận 6 số tới email. */
  async begin(rawCode: string, email: string): Promise<void> {
    const code = parseConnectCode(rawCode);
    const e = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error("Email chưa đúng");
    const client = this.make(code.url, code.anonKey);
    const { error } = await client.auth.signInWithOtp({ email: e, options: { shouldCreateUser: true } });
    if (error) throw new Error(`Không gửi được mã xác nhận: ${error.message}`);
    this.pending = { code, email: e, client };
  }

  /** Bước 2: nhập mã xác nhận → đăng nhập, vào công ty bằng mã mời, ghi máy này. */
  async verify(token: string, displayName: string): Promise<OrgStatus> {
    const p = this.pending;
    if (!p) throw new Error("Hãy dán mã kết nối và email trước");
    const { data, error } = await p.client.auth.verifyOtp({ email: p.email, token: token.trim(), type: "email" });
    if (error || !data.session || !data.user) throw new Error(`Mã xác nhận không đúng hoặc đã hết hạn${error ? `: ${error.message}` : ""}`);
    const { data: rows, error: jerr } = await p.client.rpc("join_org", { p_code: p.code.invite, p_display_name: displayName.trim() });
    if (jerr) throw new Error(jerr.message);
    const org = (rows as { org_id: string; org_name: string; role: Saved["role"] }[])[0];
    if (!org) throw new Error("Không vào được công ty");
    const prev = this.saved();
    const s: Saved = {
      url: p.code.url,
      anonKey: p.code.anonKey,
      orgId: org.org_id,
      orgName: org.org_name,
      role: org.role,
      email: p.email,
      userId: data.user.id,
      deviceId: prev?.orgId === org.org_id ? prev.deviceId : crypto.randomUUID(),
      displayName: displayName.trim(),
      refreshToken: data.session.refresh_token,
    };
    this.d.settings.setSecret(KEY, s);
    this.live = p.client;
    this.pending = null;
    await this.heartbeat();
    this.start5min();
    return this.status();
  }

  cancel() {
    this.pending = null;
  }

  /** Client đã đăng nhập (làm mới phiên bằng refresh token nếu cần). Đồng bộ các đợt sau dùng chung. */
  async client(): Promise<{ client: SupabaseClient; s: Saved }> {
    const s = this.saved();
    if (!s) throw new Error("Chưa nối doanh nghiệp");
    const c = this.live ?? this.make(s.url, s.anonKey);
    const cur = (await c.auth.getSession()).data.session;
    if (!cur || (cur.expires_at ?? 0) * 1000 - this.now() < 120_000) {
      const { data, error } = await c.auth.refreshSession({ refresh_token: s.refreshToken });
      if (error || !data.session) throw new Error(`Phiên đăng nhập doanh nghiệp hết hạn, hãy nối lại${error ? ` (${error.message})` : ""}`);
      if (data.session.refresh_token !== s.refreshToken) this.d.settings.setSecret(KEY, { ...s, refreshToken: data.session.refresh_token });
    }
    this.live = c;
    return { client: c, s: this.saved()! };
  }

  /** Báo máy còn chạy: phiên bản, các nick Zalo. Đồng thời kiểm còn là thành viên không. */
  async heartbeat(): Promise<void> {
    try {
      const { client, s } = await this.client();
      const { error } = await client.from("devices").upsert({
        id: s.deviceId,
        org_id: s.orgId,
        user_id: s.userId,
        name: this.d.deviceName ?? "",
        app_version: this.d.version,
        nicks: this.d.nicks(),
        last_seen: new Date(this.now()).toISOString(),
      });
      if (error) throw new Error(error.message);
      const { data: me } = await client.from("members").select("role, display_name").eq("org_id", s.orgId).eq("user_id", s.userId).maybeSingle();
      if (!me) {
        this.error = "Tài khoản của bạn không còn trong công ty. Hỏi quản lý, hoặc ngắt kết nối.";
      } else {
        if (me.role !== s.role || me.display_name !== s.displayName) this.d.settings.setSecret(KEY, { ...s, role: me.role, displayName: me.display_name });
        this.error = "";
      }
      this.lastSync = this.now();
    } catch (err) {
      this.error = (err as Error).message;
      this.d.log?.("Đồng bộ doanh nghiệp lỗi", { err: this.error });
    }
  }

  /** Ngắt kết nối: gỡ máy khỏi danh sách (nếu được), xoá phiên trên máy. Dữ liệu trên máy giữ nguyên. */
  async disconnect(): Promise<void> {
    const s = this.saved();
    if (s) {
      try {
        const { client } = await this.client();
        await client.from("devices").delete().eq("id", s.deviceId);
        await client.auth.signOut();
      } catch {
        /* mất mạng / phiên hết hạn: vẫn xoá trên máy */
      }
    }
    this.d.settings.set(KEY, null);
    this.live = null;
    this.error = "";
    this.lastSync = 0;
    this.stop();
  }

  private start5min() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
    this.timer.unref();
  }

  start() {
    if (!this.saved()) return;
    setTimeout(() => void this.heartbeat(), 20_000).unref();
    this.start5min();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
