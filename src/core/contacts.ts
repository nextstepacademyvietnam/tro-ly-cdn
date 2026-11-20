import type { DB } from "../server/db.js";

/**
 * Giới tính khách → cách gọi anh / chị / bạn.
 * Nguồn: ô giới tính trong hồ sơ Zalo (0 = nam, 1 = nữ), hoặc chủ sửa tay. Không đoán từ tên.
 */
export type Gender = "nam" | "nu" | "";
export type Salutation = "anh" | "chị" | "bạn";

export function genderFromZalo(raw: unknown): Gender {
  if (raw === 0 || raw === "0") return "nam";
  if (raw === 1 || raw === "1") return "nu";
  return "";
}

export function salutationOf(gender: Gender | string | null | undefined): Salutation {
  return gender === "nam" ? "anh" : gender === "nu" ? "chị" : "bạn";
}

export const capitalize = (s: string) => (s ? s[0]!.toLocaleUpperCase("vi") + s.slice(1) : s);

export interface Contact {
  userId: string;
  name: string;
  gender: Gender;
  /** "zalo": lấy từ hồ sơ Zalo; "chu": chủ sửa tay, Zalo không ghi đè. */
  source: "zalo" | "chu" | "";
  fetchedAt: number;
}

/** Hỏi Zalo hồ sơ nhiều người (tên + giới tính). Ai không đọc được thì vắng mặt trong kết quả. */
export type ProfileFetcher = (ids: string[]) => Promise<Map<string, { name: string; gender: Gender; phone?: string }>>;

const REFRESH_MS = 30 * 86_400_000;

export class ContactStore {
  /** Người đang được hỏi Zalo, để không hỏi trùng khi tin đến dồn dập. */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly db: DB,
    private readonly accountId: number,
    private readonly fetchProfiles?: ProfileFetcher,
  ) {}

  /** Số điện thoại trong hồ sơ Zalo (chỉ có khi khách là bạn bè hoặc cho xem số); "" nếu không có. */
  phone(userId: string): string {
    const r = this.db.prepare("SELECT phone FROM contacts WHERE account_id = ? AND user_id = ?").get(this.accountId, userId) as { phone: string } | undefined;
    return r?.phone ?? "";
  }

  get(userId: string): Contact | undefined {
    const r = this.db
      .prepare("SELECT user_id, name, gender, gender_source, fetched_at FROM contacts WHERE account_id = ? AND user_id = ?")
      .get(this.accountId, userId) as { user_id: string; name: string; gender: string; gender_source: string; fetched_at: number } | undefined;
    if (!r) return undefined;
    return { userId: r.user_id, name: r.name, gender: r.gender as Gender, source: r.gender_source as Contact["source"], fetchedAt: Number(r.fetched_at) };
  }

  salutation(userId: string): Salutation {
    return salutationOf(this.get(userId)?.gender);
  }

  /** Giới tính của nhiều người (đã có trong máy). */
  genders(ids: string[]): Map<string, Gender> {
    const out = new Map<string, Gender>();
    for (const id of ids) out.set(id, this.get(id)?.gender ?? "");
    return out;
  }

  /** Chủ sửa tay: giữ mãi, Zalo không ghi đè. Gender rỗng = "chưa rõ" (gọi là bạn). */
  setManual(userId: string, gender: Gender, now = Date.now()) {
    this.db
      .prepare(
        `INSERT INTO contacts (account_id, user_id, name, gender, gender_source, fetched_at) VALUES (?, ?, '', ?, 'chu', ?)
         ON CONFLICT(account_id, user_id) DO UPDATE SET gender = excluded.gender, gender_source = 'chu'`,
      )
      .run(this.accountId, userId, gender, now);
  }

  /** Trả về việc tự động (bỏ phần chủ sửa tay): lần hỏi Zalo kế tiếp ghi lại theo hồ sơ. */
  clearManual(userId: string) {
    this.db.prepare("UPDATE contacts SET gender_source = 'zalo', fetched_at = 0 WHERE account_id = ? AND user_id = ?").run(this.accountId, userId);
  }

  /** Những người cần hỏi Zalo: chưa có, hoặc lấy đã quá 30 ngày; người chủ sửa tay thì thôi. */
  needsFetch(ids: string[], now = Date.now()): string[] {
    return [...new Set(ids)].filter((id) => {
      if (!id || this.inFlight.has(id)) return false;
      const c = this.get(id);
      if (!c) return true;
      if (c.source === "chu") return false;
      // fetchedAt = 0: chưa từng hỏi Zalo, hoặc chủ vừa bấm "Theo hồ sơ Zalo" → hỏi ngay.
      return !c.fetchedAt || now - c.fetchedAt > REFRESH_MS;
    });
  }

  /** Bảo đảm đã có giới tính cho những người này (hỏi Zalo người còn thiếu). Lỗi thì bỏ qua. */
  async ensure(ids: string[], now = Date.now()): Promise<Map<string, Gender>> {
    const need = this.needsFetch(ids, now);
    if (need.length && this.fetchProfiles) {
      for (const id of need) this.inFlight.add(id);
      try {
        const got = await this.fetchProfiles(need);
        const upsert = this.db.prepare(
          `INSERT INTO contacts (account_id, user_id, name, gender, gender_source, fetched_at, phone) VALUES (?, ?, ?, ?, 'zalo', ?, ?)
           ON CONFLICT(account_id, user_id) DO UPDATE SET
             name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE contacts.name END,
             phone = CASE WHEN excluded.phone <> '' THEN excluded.phone ELSE contacts.phone END,
             gender = CASE WHEN contacts.gender_source = 'chu' THEN contacts.gender ELSE excluded.gender END,
             gender_source = CASE WHEN contacts.gender_source = 'chu' THEN 'chu' ELSE 'zalo' END,
             fetched_at = excluded.fetched_at`,
        );
        for (const [id, p] of got) upsert.run(this.accountId, id, p.name, p.gender, now, p.phone ?? "");
        // Zalo không trả hồ sơ (bị ẩn, tài khoản đã xoá): ghi "chưa rõ" để không hỏi lại mỗi tin, 30 ngày sau thử lại.
        for (const id of need) if (!got.has(id)) upsert.run(this.accountId, id, "", "", now, "");
      } catch {
        /* giới tính chỉ để xưng hô cho hay hơn; không có thì gọi "bạn" */
      } finally {
        for (const id of need) this.inFlight.delete(id);
      }
    }
    return this.genders(ids);
  }
}
