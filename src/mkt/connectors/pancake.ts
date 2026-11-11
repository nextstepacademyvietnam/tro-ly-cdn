import { dayRange, vnDay } from "../dates.js";

/**
 * Lead từ Pancake POS CRM (pos.pages.fm) — chỉ đọc, như bộ script đo lường cũ của NSG.
 *
 * - API phân trang bằng `cursor`, bỏ qua mọi bộ lọc ngày → mỗi lần lấy phải đi hết bảng, lọc ngày tại chỗ.
 * - CreatedOn là giờ UTC → đổi sang ngày VN.
 * - Đếm NGƯỜI, không đếm lượt điền form: một số điện thoại là một người, tính vào ngày sớm nhất.
 *   Bản ghi không có số điện thoại thì mỗi bản ghi là một người.
 * - Dòng nguồn (organic, lead magnet…): người trong bảng lead chính (Contact), theo nguồn của lần đầu.
 *   Lead có mã quảng cáo luôn vào "other" (chưa tách đẩy bài / low-ticket). Nguồn không khớp luật cũng vào "other".
 * - workshop: người đăng ký trong bảng workshop trong ngày (kể cả đã có ở Contact) — để thấy đủ sức kéo của chương trình.
 * - total, founder: một người tính một lần trên CẢ HAI bảng, vào ngày đầu tiên → total có thể nhỏ hơn tổng các dòng.
 * Không lưu tên, số điện thoại hay dữ liệu cá nhân nào — chỉ số đếm theo ngày.
 */

const BASE = "https://pos.pages.fm/api/v1";
const PAGE_SIZE = 100;
const MAX_PAGES = 400;

export interface LeadRules {
  /** Kênh → luật khớp nguồn (sau khi đổi chữ thường, gộp khoảng trắng). */
  channels: Record<string, { prefix: string[]; exact: string[] }>;
  founderTitles: string[];
  /** Tên bảng trong Pancake CRM. */
  contactTable: string;
  workshopTable: string;
}

/** Luật mặc định = luật NSG đang dùng (scripts/lead_source_map.json); khách khác sửa trên màn Kết nối. */
export const DEFAULT_RULES: LeadRules = {
  channels: {
    organic: { prefix: ["facebook-coach duy nguyễn", "tiktok-coach duy nguyễn", "form", "ngf - kế hoạch kinh doanh 2027"], exact: ["từ trang facebook, tiktok, youtube của coach duy nguyễn"] },
    lead_magnet: { prefix: [], exact: ["web lead magnet"] },
    gia_tot: { prefix: [], exact: ["cộng đồng gt", "cộng đồng giá tốt việt nam"] },
    partner: { prefix: [], exact: ["đối tác hợp tác", "tôi được bạn bè, đối tác giới thiệu"] },
    sale_team: { prefix: ["zalo-việt hưng", "zalo-vũ hiếu"], exact: ["tôi được đội ngũ của coach duy nguyễn mời", "sale tự nhập"] },
    alumni: { prefix: [], exact: ["học viên cũ", "tôi là học viên đã từng tham gia các chương trình trước đây"] },
  },
  founderTitles: ["ceo/chủ doanh nghiệp", "doanh nghiệp", "chuyên gia / tự kinh doanh", "kinh doanh tự do", "coaching/trainer"],
  contactTable: "Contact",
  workshopTable: "lien_hechuoi_ws",
};

export const LEAD_METRICS = ["total", "organic", "lead_magnet", "gia_tot", "workshop", "partner", "sale_team", "alumni", "other", "founder"] as const;

type Fetch = typeof fetch;
type Row = Record<string, unknown>;

export class PancakeError extends Error {
  constructor(
    message: string,
    readonly reconnect = false,
  ) {
    super(message);
  }
  get needsReconnect() {
    return this.reconnect;
  }
}

export const clean = (v: unknown) => (v === null || v === undefined ? "" : String(v).normalize("NFC").trim().replace(/\s+/g, " "));
const lower = (v: unknown) => clean(v).toLowerCase();

/** Số VN: 0xxxxxxxxx, +84xxxxxxxxx, 84xxxxxxxxx → 0xxxxxxxxx. */
export function normPhone(v: unknown): string | null {
  if (!v) return null;
  let d = String(v).replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("84") && d.length >= 11) d = `0${d.slice(2)}`;
  if (!d.startsWith("0") && d.length === 9) d = `0${d}`;
  return d || null;
}

/** Ngày VN của bản ghi (CreatedOn là UTC). */
export function dayOf(r: Row): string | null {
  const c = r.CreatedOn;
  if (c) {
    const t = Date.parse(`${String(c).replace("Z", "").slice(0, 19)}Z`);
    return Number.isFinite(t) ? vnDay(t) : String(c).slice(0, 10);
  }
  const f = r.thoi_diem_dang_ky_moi_nhat;
  return f ? String(f).slice(0, 10) : null;
}

const sourceOf = (r: Row) => clean(r.nguon_khach_hang || r.anh_chi_nhan_duoc_form_dang_ky_nay_tu_dau);

export function classifySource(source: string, hasAd: boolean, rules: LeadRules): string {
  if (hasAd || !source) return "other";
  const label = source.toLowerCase();
  for (const [channel, rule] of Object.entries(rules.channels)) {
    if (rule.exact.includes(label) || rule.prefix.some((p) => label.startsWith(p))) return channel;
  }
  return "other";
}

/** Số lead theo ngày — đúng cách của bộ script cũ (xem chú thích đầu file). */
export function leadDaily(contact: Row[], workshop: Row[], rules: LeadRules): Map<string, Record<string, number>> {
  const founder = new Set(rules.founderTitles.map((t) => t.toLowerCase()));
  const days = new Map<string, Record<string, number>>();
  const bump = (day: string, key: string) => {
    const d = days.get(day) ?? {};
    d[key] = (d[key] ?? 0) + 1;
    days.set(day, d);
  };
  const dated = [
    ...contact.map((r, i) => ({ day: dayOf(r), table: "c" as const, i, r })),
    ...workshop.map((r, i) => ({ day: dayOf(r), table: "w" as const, i, r })),
  ]
    .filter((x): x is { day: string; table: "c" | "w"; i: number; r: Row } => Boolean(x.day))
    .sort((a, b) => String(a.r.CreatedOn ?? a.day).localeCompare(String(b.r.CreatedOn ?? b.day)));

  const people = new Map<string, { day: string; title: string }>();
  const contactFirst = new Map<string, { day: string; source: string; hasAd: boolean }>();
  const wsSeen = new Set<string>();
  for (const { day, table, i, r } of dated) {
    const key = normPhone(r.Phone || r.phone_number) ?? `row:${table}${i}`;
    const person = people.get(key) ?? { day, title: "" };
    people.set(key, person);
    const title = clean(r.chuc_danh);
    if (title) person.title = title;
    if (table === "w") {
      if (!wsSeen.has(`${day}|${key}`)) {
        wsSeen.add(`${day}|${key}`);
        bump(day, "workshop");
      }
      continue;
    }
    const first = contactFirst.get(key) ?? { day, source: "", hasAd: Boolean(r.ad_id || r.Ads) };
    contactFirst.set(key, first);
    if (!first.source) first.source = sourceOf(r);
  }
  for (const p of contactFirst.values()) bump(p.day, classifySource(lower(p.source), p.hasAd, rules));
  for (const p of people.values()) {
    bump(p.day, "total");
    if (founder.has(lower(p.title))) bump(p.day, "founder");
  }
  return days;
}

async function walk(f: Fetch, shop: string, table: string, key: string): Promise<Row[]> {
  const rows: Row[] = [];
  const seen = new Set<string>();
  let cursor = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({ api_key: key, page_size: String(PAGE_SIZE), ...(cursor ? { cursor } : {}) });
    let body: { data?: { entries?: Row[]; cursor?: string }; message?: string; success?: boolean } = {};
    let status = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await f(`${BASE}/shops/${encodeURIComponent(shop)}/crm/${encodeURIComponent(table)}/records?${q}`, { signal: AbortSignal.timeout(90_000) });
      status = res.status;
      body = (await res.json().catch(() => ({}))) as typeof body;
      if (res.ok || status === 401 || status === 403) break;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
    if (status === 401 || status === 403) throw new PancakeError("Pancake từ chối API key — kiểm tra lại key và Shop ID", true);
    if (status === 404) throw new PancakeError(`Không có bảng "${table}" trong CRM của shop này`);
    if (status < 200 || status >= 300) throw new PancakeError(`Pancake trả lỗi ${status}${body.message ? `: ${body.message}` : ""}`);
    const entries = body.data?.entries ?? [];
    rows.push(...entries);
    const next = body.data?.cursor;
    if (!entries.length || !next || seen.has(next)) break;
    seen.add(next);
    cursor = next;
  }
  return rows;
}

export interface PancakePull {
  daily: Record<string, [string, number | null][]>;
  rows: number;
  dataUntil: string;
}

/** Đi hết hai bảng rồi trả số theo ngày cho khoảng [since, today] (ngày không có lead = 0). */
export async function pancakePull(f: Fetch, cred: { apiKey: string; shopId: string }, rules: LeadRules, since: string, today: string): Promise<PancakePull> {
  const contact = await walk(f, cred.shopId, rules.contactTable, cred.apiKey);
  const workshop = rules.workshopTable ? await walk(f, cred.shopId, rules.workshopTable, cred.apiKey) : [];
  const byDay = leadDaily(contact, workshop, rules);
  const days = dayRange(since, today);
  const daily: Record<string, [string, number | null][]> = {};
  for (const m of LEAD_METRICS) daily[m] = days.map((d) => [d, byDay.get(d)?.[m] ?? 0]);
  const last = [...byDay.keys()].filter((d) => d <= today).sort().at(-1) ?? "";
  return { daily, rows: contact.length + workshop.length, dataUntil: last > today ? today : last };
}

/** Kiểm tra key + shop bằng một trang của bảng lead chính. */
export async function pancakeCheck(f: Fetch, cred: { apiKey: string; shopId: string }, table: string): Promise<void> {
  const q = new URLSearchParams({ api_key: cred.apiKey, page_size: "1" });
  const res = await f(`${BASE}/shops/${encodeURIComponent(cred.shopId)}/crm/${encodeURIComponent(table)}/records?${q}`, { signal: AbortSignal.timeout(30_000) });
  if (res.status === 401 || res.status === 403) throw new PancakeError("Pancake từ chối API key — kiểm tra lại key và Shop ID", true);
  if (res.status === 404) throw new PancakeError(`Không thấy bảng "${table}" — kiểm tra Shop ID và tên bảng`);
  if (!res.ok) throw new PancakeError(`Pancake trả lỗi ${res.status}`);
}
