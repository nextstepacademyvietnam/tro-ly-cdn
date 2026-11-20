import crypto from "node:crypto";
import type { Inbox } from "../channels/zalo/inbox.js";
import { normPhone, walk } from "../mkt/connectors/pancake.js";
import type { DB } from "../server/db.js";

/** Làm mới chỉ mục CRM mỗi 6 giờ (API Pancake không lọc theo số nên phải đọc cả bảng). */
export const REFRESH_MS = 6 * 3_600_000;
const META_KEY = "crm.indexedAt";
const SAVE_TABLE_KEY = "crm.saveTable";
/** Bảng CRM NSG lập riêng cho bot ghi khách mới. */
const BOT_TABLE = "lien_he_moi__bot";
const API = "https://pos.pages.fm/api/v1";

export interface CrmTable {
  name: string;
  label: string;
  fields: string[];
}

export interface CrmCred {
  apiKey: string;
  shopId: string;
  contactTable: string;
  workshopTable: string;
}

/** Một bản ghi khớp trong CRM (chỉ các trường làm việc). */
export interface CrmMatch {
  table: string;
  kind: "lead" | "workshop";
  recordId: string;
  createdOn: string;
  name: string;
  status: string;
  /** Các dòng "nhãn: giá trị" để hiện và đưa AI đọc. */
  fields: [string, string][];
  link: string;
}

type Row = Record<string, unknown>;

/** Trường hiện ra cho từng loại bảng (nhãn tiếng Việt). Trường trống thì bỏ. */
const LEAD_FIELDS: [string, string][] = [
  ["san_pham_chot", "Sản phẩm đã chốt"],
  ["so_don_da_mua", "Số đơn đã mua"],
  ["tien_trinh_kh", "Tiến trình"],
  ["Hotness", "Độ nóng"],
  ["uu_tien", "Ưu tiên"],
  ["Owner_obj", "Người phụ trách"],
  ["NextFollowUpDate", "Hẹn chăm sóc"],
  ["nguon_khach_hang", "Nguồn"],
  ["chuc_danh", "Chức danh"],
  ["nganh_nghe", "Ngành nghề"],
  ["quy_mo_doanh_nghiep", "Quy mô"],
  ["van_de", "Vấn đề"],
  ["insight_kh_chot", "Insight"],
  ["ly_do_chua_chot", "Lý do chưa chốt"],
  ["ly_do_chua_phu_hop", "Lý do chưa phù hợp"],
  ["Note", "Ghi chú"],
];
const WORKSHOP_FIELDS: [string, string][] = [
  ["xac_nhan_tham_gia", "Xác nhận tham gia"],
  ["chu_de_quan_tam", "Chủ đề quan tâm"],
  ["Ket qua", "Kết quả"],
  ["Owner_obj", "Người phụ trách"],
  ["Note", "Ghi chú"],
];

/** Giá trị CRM (chữ, số, mảng, đối tượng có name) → chữ gọn. */
export function text(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(text).filter(Boolean).join(", ");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return text(o.name ?? o.Name ?? o.label ?? o.value ?? o.title ?? "");
  }
  return String(v).normalize("NFC").replace(/\s+/g, " ").trim().slice(0, 300);
}

export type PhoneSource = "crm" | "chu" | "zalo" | "chat";

/** Trạng thái lead đang được theo (ưu tiên tìm Zalo trước). */
export const ACTIVE_STATUSES = ["mới", "tiếp cận", "hẹn chốt", "phân loại", "hợp đồng", "tbsp", "hẹn trao đổi"];
const DAY = 86_400_000;

/**
 * 0 = khách đang theo: lead / đăng ký workshop trong 60 ngày, hoặc lead trạng thái đang làm trong 180 ngày.
 * 1 = lead cũ (tìm Zalo sau).
 */
export function priorityOf(r: Row, kind: "lead" | "workshop", now: number): 0 | 1 {
  const c = Date.parse(`${String(r.CreatedOn ?? "").replace(" ", "T").replace("Z", "").slice(0, 19)}Z`);
  const age = Number.isFinite(c) ? now - c : Infinity;
  if (age <= 60 * DAY) return 0;
  if (kind === "lead" && age <= 180 * DAY && ACTIVE_STATUSES.includes(text(r.Status).toLowerCase())) return 0;
  return 1;
}

export const hashPhone = (phone: string) => crypto.createHash("sha256").update(`cdn-crm:${phone}`).digest("hex");

/** Mọi số điện thoại của một bản ghi CRM (đã chuẩn hoá 0xxxxxxxxx). */
export function phonesOf(r: Row): string[] {
  const raw: unknown[] = [r.Phone, r.phone_number, r.phone];
  if (Array.isArray(r.Phones)) raw.push(...r.Phones.map((p) => (typeof p === "object" && p ? (p as Row).phone_number ?? (p as Row).phone ?? (p as Row).value : p)));
  else raw.push(r.Phones);
  return [...new Set(raw.map(normPhone).filter((p): p is string => Boolean(p && /^0\d{9}$/.test(p))))];
}

/** Số di động VN trong một đoạn chữ (khách hay gõ "sđt 0912 345 678", "+84 912345678"). */
export function phonesIn(t: string): string[] {
  const out = new Set<string>();
  for (const m of t.matchAll(/(?:\+?84|0)(?:[\s.\-]?\d){9}(?!\d)/g)) {
    const p = normPhone(m[0]);
    if (p && /^0[35789]\d{8}$/.test(p)) out.add(p);
  }
  return [...out];
}

/**
 * Tra khách Zalo trong Pancake CRM (bảng lead + bảng đăng ký workshop) theo số điện thoại: số khách gõ trong
 * hội thoại, hoặc số chủ nhập tay. Chỉ đọc CRM. Kết quả hiện ở Hộp thư và đưa vào lời dặn AI để trợ lý biết
 * khách đang ở đâu (không bao giờ tự xác nhận thanh toán với khách).
 */
export class CrmService {
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private refreshing: Promise<number> | null = null;
  lastError = "";

  constructor(
    private readonly d: {
      db: DB;
      cred(): CrmCred | null;
      fetch?: typeof fetch;
      now?: () => number;
      log?: (msg: string, extra?: object) => void;
      /** Mã hoá số điện thoại trong chỉ mục (để bộ tìm Zalo theo số đọc lại được); không có thì không lưu số. */
      box?: { encrypt(plain: string): string; decrypt(sealed: string): string };
    },
  ) {
    this.now = d.now ?? Date.now;
  }

  available(): boolean {
    return this.d.cred() !== null;
  }

  indexedAt(): number {
    const r = this.d.db.prepare("SELECT value FROM settings WHERE key = ?").get(META_KEY) as { value: string } | undefined;
    return r ? Number(JSON.parse(r.value)) || 0 : 0;
  }

  /** Dựng lại chỉ mục từ các bản ghi (tách riêng để test không cần gọi Pancake). */
  rebuild(tables: { table: string; kind: CrmMatch["kind"]; rows: Row[] }[]): number {
    const ins = this.d.db.prepare(
      "INSERT OR REPLACE INTO crm_index (phone_hash, table_name, record_id, created_on, data, priority, phone_enc) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const now = this.now();
    let n = 0;
    this.d.db.exec("BEGIN");
    try {
      this.d.db.exec("DELETE FROM crm_index");
      for (const t of tables) {
        const fields = t.kind === "lead" ? LEAD_FIELDS : WORKSHOP_FIELDS;
        for (const r of t.rows) {
          const phones = phonesOf(r);
          if (!phones.length) continue;
          const data = {
            kind: t.kind,
            name: text(r.Name),
            status: text(r.Status),
            link: text(r.pancake_link),
            fields: fields.map(([k, label]) => [label, text(r[k])]).filter(([, v]) => v),
          };
          const id = text(r.id ?? r.display_id ?? r.CustomerID) || `${t.table}:${n}`;
          const prio = priorityOf(r, t.kind, now);
          for (const p of phones) ins.run(hashPhone(p), t.table, id, text(r.CreatedOn), JSON.stringify(data), prio, this.d.box?.encrypt(p) ?? "");
          n++;
        }
      }
      this.d.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(META_KEY, JSON.stringify(this.now()));
      this.d.db.exec("COMMIT");
    } catch (err) {
      this.d.db.exec("ROLLBACK");
      throw err;
    }
    return n;
  }

  /** Đọc lại cả hai bảng CRM và dựng chỉ mục. Gọi chồng thì dùng chung một lần đọc. */
  refresh(): Promise<number> {
    if (this.refreshing) return this.refreshing;
    const cred = this.d.cred();
    if (!cred) return Promise.resolve(0);
    const f = this.d.fetch ?? fetch;
    this.refreshing = (async () => {
      try {
        const tables: { table: string; kind: CrmMatch["kind"]; rows: Row[] }[] = [
          { table: cred.contactTable, kind: "lead", rows: await walk(f, cred.shopId, cred.contactTable, cred.apiKey) },
        ];
        if (cred.workshopTable) tables.push({ table: cred.workshopTable, kind: "workshop", rows: await walk(f, cred.shopId, cred.workshopTable, cred.apiKey) });
        const n = this.rebuild(tables);
        this.lastError = "";
        return n;
      } catch (err) {
        this.lastError = (err as Error).message;
        this.d.log?.("Không đọc được Pancake CRM", { err: this.lastError });
        throw err;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  linkedPhone(accountId: number, threadId: string): string {
    const r = this.d.db.prepare("SELECT phone FROM crm_links WHERE account_id = ? AND thread_id = ?").get(accountId, threadId) as { phone: string } | undefined;
    return r?.phone ?? "";
  }

  /** Chủ nhập số điện thoại cho hội thoại (rỗng = bỏ). Trả số đã chuẩn hoá. */
  link(accountId: number, threadId: string, phone: string): string {
    const p = phone.trim() ? normPhone(phone) : "";
    if (phone.trim() && !(p && /^0\d{9}$/.test(p))) throw new Error("Số điện thoại chưa đúng (cần 10 số, VD 0912345678)");
    if (!p) this.d.db.prepare("DELETE FROM crm_links WHERE account_id = ? AND thread_id = ?").run(accountId, threadId);
    else this.d.db.prepare("INSERT OR REPLACE INTO crm_links (account_id, thread_id, phone, at) VALUES (?, ?, ?, ?)").run(accountId, threadId, p, this.now());
    return p ?? "";
  }

  /** Số điện thoại của khách: số chủ nhập trước, rồi các số khách tự gõ trong hội thoại (mới trước). */
  phonesFor(accountId: number, threadId: string, inbox: Pick<Inbox, "messages">, profilePhone = ""): { phone: string; from: PhoneSource }[] {
    const out: { phone: string; from: PhoneSource }[] = [];
    // Nguồn chắc nhất: số của lead trong CRM mà Zalo tìm ra đúng tài khoản đang nhắn (không phụ thuộc tên).
    for (const p of this.crmPhonesOfUid(accountId, threadId)) if (!out.some((x) => x.phone === p)) out.push({ phone: p, from: "crm" });
    const linked = this.linkedPhone(accountId, threadId);
    if (linked && !out.some((x) => x.phone === linked)) out.push({ phone: linked, from: "chu" });
    const z = normPhone(profilePhone);
    if (z && /^0\d{9}$/.test(z) && !out.some((x) => x.phone === z)) out.push({ phone: z, from: "zalo" });
    const msgs = inbox.messages(threadId, 300).filter((m) => m.direction === "in" && m.text);
    for (const m of msgs.reverse()) for (const p of phonesIn(m.text!)) if (!out.some((x) => x.phone === p)) out.push({ phone: p, from: "chat" });
    return out.slice(0, 5);
  }

  /** Số (đã giải mã) của các lead CRM mà Zalo tìm ra là tài khoản `uid` này, trên nick `accountId`. */
  crmPhonesOfUid(accountId: number, uid: string): string[] {
    if (!this.d.box || !uid) return [];
    const rows = this.d.db
      .prepare(
        `SELECT DISTINCT i.phone_enc FROM crm_zalo z JOIN crm_index i ON i.phone_hash = z.phone_hash
         WHERE z.account_id = ? AND z.uid = ? AND i.phone_enc <> ''`,
      )
      .all(accountId, uid) as { phone_enc: string }[];
    const out = new Set<string>();
    for (const r of rows) {
      try {
        out.add(this.d.box.decrypt(r.phone_enc));
      } catch {
        /* khoá mã hoá đổi: bỏ qua */
      }
    }
    return [...out];
  }

  matches(phones: string[]): CrmMatch[] {
    if (!phones.length) return [];
    const q = this.d.db.prepare("SELECT * FROM crm_index WHERE phone_hash = ? ORDER BY created_on DESC");
    const seen = new Set<string>();
    const out: CrmMatch[] = [];
    for (const p of phones) {
      for (const r of q.all(hashPhone(p)) as { table_name: string; record_id: string; created_on: string; data: string }[]) {
        const key = `${r.table_name}|${r.record_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const d = JSON.parse(r.data) as { kind: CrmMatch["kind"]; name: string; status: string; link: string; fields: [string, string][] };
        out.push({ table: r.table_name, recordId: r.record_id, createdOn: r.created_on, ...d });
      }
    }
    return out.sort((a, b) => (a.kind === b.kind ? b.createdOn.localeCompare(a.createdOn) : a.kind === "lead" ? -1 : 1));
  }

  lookup(accountId: number, threadId: string, inbox: Pick<Inbox, "messages">, profilePhone = "") {
    const phones = this.phonesFor(accountId, threadId, inbox, profilePhone);
    return { phones, matches: this.matches(phones.map((p) => p.phone)) };
  }

  /** Khối CRM cho lời dặn AI ("" nếu không khớp). */
  note(accountId: number, threadId: string, inbox: Pick<Inbox, "messages">, profilePhone = ""): string {
    const { matches } = this.lookup(accountId, threadId, inbox, profilePhone);
    if (!matches.length) return "";
    const lines = ["Theo CRM nội bộ của chủ (chỉ để hiểu khách; KHÔNG tự xác nhận đã thanh toán, đã giữ chỗ hay đã chốt với khách, việc đó chủ làm):"];
    for (const m of matches.slice(0, 3)) {
      const day = m.createdOn ? m.createdOn.slice(0, 10).split("-").reverse().join("/") : "";
      const head = m.kind === "workshop" ? `- Đăng ký workshop${day ? ` ngày ${day}` : ""}` : `- Lead${day ? ` từ ${day}` : ""}`;
      const fields = m.fields.filter(([k]) => k !== "Người phụ trách" && k !== "Ghi chú").map(([k, v]) => `${k}: ${v}`);
      lines.push(`${head}${m.status ? `, trạng thái ${m.status}` : ""}${fields.length ? `; ${fields.join("; ")}` : ""}`);
    }
    return lines.join("\n");
  }

  // ---------- Ghi lead vào CRM ----------

  private tablesCache: { at: number; list: CrmTable[] } | null = null;

  /** Các bảng CRM của shop (tên, nhãn, các trường), nhớ 10 phút. */
  async tables(): Promise<CrmTable[]> {
    if (this.tablesCache && this.now() - this.tablesCache.at < 600_000) return this.tablesCache.list;
    const cred = this.d.cred();
    if (!cred) throw new Error("Chưa nối Pancake CRM");
    const res = await (this.d.fetch ?? fetch)(
      `${API}/shops/${encodeURIComponent(cred.shopId)}/crm/tables?${new URLSearchParams({ api_key: cred.apiKey })}`,
      { signal: AbortSignal.timeout(30_000) },
    );
    const j = (await res.json().catch(() => ({}))) as { tables?: { name?: string; label?: string; is_removed?: boolean; sections?: { fields?: { name?: string }[] }[] }[]; message?: string };
    if (!res.ok || !Array.isArray(j.tables)) throw new Error(`Pancake trả lỗi ${res.status}${j.message ? `: ${j.message}` : ""}`);
    const list = j.tables
      .filter((t) => t.name && !t.is_removed && (t.sections ?? []).length)
      .map((t) => ({
        name: String(t.name),
        label: String(t.label ?? t.name),
        fields: (t.sections ?? []).flatMap((s) => (s.fields ?? []).map((f) => String(f.name ?? ""))).filter(Boolean),
      }));
    this.tablesCache = { at: this.now(), list };
    return list;
  }

  /** Bảng mặc định để lưu lead: lần lưu trước, rồi bảng "Liên hệ mới - Bot" nếu có, rồi bảng lead chính. */
  defaultTable(list: CrmTable[]): string {
    const r = this.d.db.prepare("SELECT value FROM settings WHERE key = ?").get(SAVE_TABLE_KEY) as { value: string } | undefined;
    const last = r ? String(JSON.parse(r.value)) : "";
    if (last && list.some((t) => t.name === last)) return last;
    if (list.some((t) => t.name === BOT_TABLE)) return BOT_TABLE;
    return this.d.cred()?.contactTable ?? list[0]?.name ?? "";
  }

  saved(accountId: number, threadId: string): { table: string; recordId: string; phone: string; at: number }[] {
    return (
      this.d.db.prepare("SELECT table_name, record_id, phone, at FROM crm_saved WHERE account_id = ? AND thread_id = ? ORDER BY at DESC").all(accountId, threadId) as {
        table_name: string;
        record_id: string;
        phone: string;
        at: number;
      }[]
    ).map((r) => ({ table: r.table_name, recordId: r.record_id, phone: r.phone, at: Number(r.at) }));
  }

  /**
   * Lưu khách vào một bảng CRM: lần đầu tạo bản ghi, lần sau (cùng hội thoại, cùng bảng) thì cập nhật bản ghi đó.
   * Chỉ ghi các trường bảng có (Tên, Số điện thoại, Ghi chú; bảng bot thì thêm tóm tắt chăm sóc).
   */
  async saveLead(
    accountId: number,
    threadId: string,
    input: { table: string; name: string; phone: string; note: string },
  ): Promise<{ recordId: string; created: boolean }> {
    const cred = this.d.cred();
    if (!cred) throw new Error("Chưa nối Pancake CRM");
    const name = input.name.trim().slice(0, 200);
    const phone = input.phone.trim() ? normPhone(input.phone) : "";
    if (input.phone.trim() && !(phone && /^0\d{9}$/.test(phone))) throw new Error("Số điện thoại chưa đúng (cần 10 số, VD 0912345678)");
    if (!name && !phone) throw new Error("Cần ít nhất tên hoặc số điện thoại");
    const table = (await this.tables()).find((t) => t.name === input.table);
    if (!table) throw new Error("Không có bảng này trong CRM");
    const has = (f: string) => table.fields.includes(f);
    const note = input.note.trim().slice(0, 3000);
    const record: Record<string, string> = {};
    if (has("Name") && name) record.Name = name;
    if (has("Phone") && phone) record.Phone = phone;
    if (has("Note") && note) record.Note = note;
    if (has("bot_care_summary") && note) record.bot_care_summary = note;
    const prev = this.saved(accountId, threadId).find((s) => s.table === table.name);
    if (prev) record.id = prev.recordId;
    const res = await (this.d.fetch ?? fetch)(
      `${API}/shops/${encodeURIComponent(cred.shopId)}/crm/${encodeURIComponent(table.name)}/records?${new URLSearchParams({ api_key: cred.apiKey })}`,
      { method: prev ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ record }), signal: AbortSignal.timeout(30_000) },
    );
    const j = (await res.json().catch(() => ({}))) as { data?: { record?: Row; success?: boolean }; record?: Row; success?: boolean; message?: string };
    const rec = j.data?.record ?? j.record;
    const id = text(rec?.id) || prev?.recordId || "";
    if (!res.ok || !id) throw new Error(`Pancake không lưu được${j.message ? `: ${j.message}` : ` (mã ${res.status})`}`);
    const now = this.now();
    this.d.db
      .prepare("INSERT OR REPLACE INTO crm_saved (account_id, thread_id, table_name, record_id, phone, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(accountId, threadId, table.name, id, phone ?? "", now);
    this.d.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(SAVE_TABLE_KEY, JSON.stringify(table.name));
    // Tra ra ngay, không phải chờ lần đọc lại CRM.
    if (phone) {
      const data = { kind: "lead", name: name || text(rec?.Name), status: text(rec?.Status) ? "Mới" : "", link: text(rec?.pancake_link), fields: note ? [["Ghi chú", note.slice(0, 300)]] : [] };
      this.d.db
        .prepare("INSERT OR REPLACE INTO crm_index (phone_hash, table_name, record_id, created_on, data, priority, phone_enc) VALUES (?, ?, ?, ?, ?, 0, ?)")
        .run(hashPhone(phone), table.name, id, text(rec?.CreatedOn) || new Date(now).toISOString(), JSON.stringify(data), this.d.box?.encrypt(phone) ?? "");
    }
    return { recordId: id, created: !prev };
  }

  /** Tới lúc đọc lại CRM: chỉ mục cũ hơn 6 giờ, hoặc dựng bằng bản cũ chưa có số mã hoá (bộ tìm Zalo cần). */
  needsRefresh(): boolean {
    if (this.now() - this.indexedAt() >= REFRESH_MS - 60_000) return true;
    return Boolean(this.d.box && this.d.db.prepare("SELECT 1 FROM crm_index WHERE phone_enc = '' LIMIT 1").get());
  }

  start() {
    if (this.timer) return;
    const run = () => {
      if (this.needsRefresh()) void this.refresh().catch(() => undefined);
    };
    setTimeout(run, 60_000).unref();
    this.timer = setInterval(run, 15 * 60_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
