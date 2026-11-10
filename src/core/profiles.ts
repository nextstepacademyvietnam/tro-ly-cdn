import type { DB } from "../server/db.js";
import { conversationHasLabel } from "../channels/zalo/protocol.js";
import type { PersonaDoc } from "./documents.js";
import { type Faq, type Identity, type TimelyNote, composeProfilePrompt, identityLength, parseIdentity } from "./promptLayers.js";

export type SendMode = "draft" | "auto";
export type Applies = "both" | "user" | "group";

export interface Profile {
  id: number;
  accountId: number;
  name: string;
  /** Tên nhãn kích hoạt tính cách này (nhãn Zalo hoặc tag trên trang quản trị). */
  tag: string;
  /** Tầng 1 — danh tính & nguyên tắc (ít đổi). */
  identity: Identity;
  sendMode: SendMode;
  applies: Applies;
  /** Số nhỏ hơn = ưu tiên cao hơn khi hội thoại mang nhiều nhãn. */
  priority: number;
  updatedAt: number;
}

export interface ProfileInput {
  name: string;
  tag: string;
  identity: Partial<Identity>;
  sendMode: SendMode;
  applies: Applies;
  priority: number;
}

export class ProfileError extends Error {}

export const MAX_PROMPT_CHARS = 30_000;

interface Row {
  id: number;
  account_id: number;
  name: string;
  tag: string;
  identity: string;
  send_mode: SendMode;
  applies: Applies;
  priority: number;
  updated_at: number;
}

const toProfile = (r: Row): Profile => ({
  id: r.id,
  accountId: r.account_id,
  name: r.name,
  tag: r.tag,
  identity: parseIdentity(r.identity),
  sendMode: r.send_mode,
  applies: r.applies,
  priority: r.priority,
  updatedAt: r.updated_at,
});

export class ProfileStore {
  constructor(private readonly db: DB) {}

  list(accountId: number): Profile[] {
    return (this.db.prepare("SELECT * FROM profiles WHERE account_id = ? ORDER BY priority, id").all(accountId) as unknown as Row[]).map(toProfile);
  }

  get(id: number): Profile | undefined {
    const r = this.db.prepare("SELECT * FROM profiles WHERE id = ?").get(id) as unknown as Row | undefined;
    return r ? toProfile(r) : undefined;
  }

  private validate(accountId: number, input: ProfileInput, selfId?: number): Omit<ProfileInput, "identity"> & { identity: Identity } {
    const name = (input.name ?? "").trim().slice(0, 80);
    const tag = (input.tag ?? "").trim().slice(0, 60);
    const identity = parseIdentity(input.identity ?? {});
    if (!name) throw new ProfileError("Đặt tên cho tính cách");
    if (identityLength(identity) > MAX_PROMPT_CHARS) throw new ProfileError(`Hướng dẫn dài quá ${MAX_PROMPT_CHARS.toLocaleString("vi-VN")} ký tự — hãy đưa phần kiến thức vào file`);
    if (!["draft", "auto"].includes(input.sendMode)) throw new ProfileError("Cách gửi không hợp lệ");
    if (!["both", "user", "group"].includes(input.applies)) throw new ProfileError("Phạm vi không hợp lệ");
    if (tag) {
      const dup = this.list(accountId).find((p) => p.id !== selfId && p.tag.toLocaleLowerCase("vi") === tag.toLocaleLowerCase("vi"));
      if (dup) throw new ProfileError(`Nhãn "${tag}" đã dùng cho tính cách "${dup.name}"`);
      const off = this.offTag(accountId);
      if (tag.toLocaleLowerCase("vi") === off.toLocaleLowerCase("vi")) throw new ProfileError(`"${off}" là nhãn tắt bot, hãy chọn tên khác`);
    }
    const priority = Number.isFinite(Number(input.priority)) ? Math.max(1, Math.min(999, Math.round(Number(input.priority)))) : 100;
    return { name, tag, identity, sendMode: input.sendMode, applies: input.applies, priority };
  }

  create(accountId: number, input: ProfileInput): Profile {
    const v = this.validate(accountId, input);
    const now = Date.now();
    const r = this.db
      .prepare(
        `INSERT INTO profiles (account_id, name, tag, identity, send_mode, applies, priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(accountId, v.name, v.tag, JSON.stringify(v.identity), v.sendMode, v.applies, v.priority, now, now);
    return this.get(Number(r.lastInsertRowid))!;
  }

  update(id: number, input: ProfileInput): Profile {
    const cur = this.get(id);
    if (!cur) throw new ProfileError("Không có tính cách này");
    const v = this.validate(cur.accountId, input, id);
    this.db
      .prepare("UPDATE profiles SET name = ?, tag = ?, identity = ?, send_mode = ?, applies = ?, priority = ?, updated_at = ? WHERE id = ?")
      .run(v.name, v.tag, JSON.stringify(v.identity), v.sendMode, v.applies, v.priority, Date.now(), id);
    return this.get(id)!;
  }

  // ---------- Tầng 2: hỏi đáp ----------
  faqs(profileId: number): (Faq & { id: number; updatedAt: number })[] {
    return (this.db.prepare("SELECT id, question, answer, updated_at FROM profile_faqs WHERE profile_id = ? ORDER BY id").all(profileId) as {
      id: number;
      question: string;
      answer: string;
      updated_at: number;
    }[]).map((r) => ({ id: r.id, question: r.question, answer: r.answer, updatedAt: r.updated_at }));
  }

  saveFaq(profileId: number, faq: Faq, id?: number): number {
    const q = (faq.question ?? "").trim().slice(0, 500);
    const a = (faq.answer ?? "").trim().slice(0, 3000);
    if (!q || !a) throw new ProfileError("Cần cả câu hỏi và câu trả lời");
    if (id) {
      this.db.prepare("UPDATE profile_faqs SET question = ?, answer = ?, updated_at = ? WHERE id = ? AND profile_id = ?").run(q, a, Date.now(), id, profileId);
      return id;
    }
    return Number(this.db.prepare("INSERT INTO profile_faqs (profile_id, question, answer, updated_at) VALUES (?, ?, ?, ?)").run(profileId, q, a, Date.now()).lastInsertRowid);
  }

  removeFaq(profileId: number, id: number) {
    this.db.prepare("DELETE FROM profile_faqs WHERE id = ? AND profile_id = ?").run(id, profileId);
  }

  // ---------- Tầng 3: ghi chú có hạn ----------
  notes(profileId: number): (TimelyNote & { id: number; updatedAt: number })[] {
    return (this.db.prepare("SELECT id, text, expires_on, updated_at FROM profile_notes WHERE profile_id = ? ORDER BY COALESCE(expires_on, '9999'), id").all(profileId) as {
      id: number;
      text: string;
      expires_on: string | null;
      updated_at: number;
    }[]).map((r) => ({ id: r.id, text: r.text, expiresOn: r.expires_on, updatedAt: r.updated_at }));
  }

  saveNote(profileId: number, note: TimelyNote, id?: number): number {
    const text = (note.text ?? "").trim().slice(0, 1000);
    const exp = note.expiresOn && /^\d{4}-\d{2}-\d{2}$/.test(note.expiresOn) ? note.expiresOn : null;
    if (!text) throw new ProfileError("Ghi chú trống");
    if (id) {
      // Sửa nội dung / hạn → nhắc lại nếu sắp hết hạn.
      this.db.prepare("UPDATE profile_notes SET text = ?, expires_on = ?, reminded = 0, updated_at = ? WHERE id = ? AND profile_id = ?").run(text, exp, Date.now(), id, profileId);
      return id;
    }
    return Number(
      this.db.prepare("INSERT INTO profile_notes (profile_id, text, expires_on, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(profileId, text, exp, Date.now(), Date.now()).lastInsertRowid,
    );
  }

  removeNote(profileId: number, id: number) {
    this.db.prepare("DELETE FROM profile_notes WHERE id = ? AND profile_id = ?").run(id, profileId);
  }

  /** Tầng 1–3 ghép sẵn cho AI. `identity` cho phép thử bản đang soạn mà chưa lưu. */
  compose(profileId: number, identity?: Identity, now = Date.now()): string {
    const p = this.get(profileId);
    if (!p) return "";
    return composeProfilePrompt({
      name: p.name,
      identity: identity ?? p.identity,
      docs: this.docs(profileId),
      faqs: this.faqs(profileId),
      notes: this.notes(profileId),
      now,
    });
  }

  remove(id: number): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE conversations SET assigned_profile_id = NULL WHERE assigned_profile_id = ?").run(id);
      this.db.prepare("DELETE FROM persona_files WHERE profile_id = ?").run(id);
      this.db.prepare("DELETE FROM profile_faqs WHERE profile_id = ?").run(id);
      this.db.prepare("DELETE FROM profile_notes WHERE profile_id = ?").run(id);
      this.db.prepare("DELETE FROM profiles WHERE id = ?").run(id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ---------- Tài liệu của tính cách ----------
  files(profileId: number) {
    return this.db
      .prepare("SELECT id, name, bytes, length(text) AS chars, created_at FROM persona_files WHERE profile_id = ? ORDER BY id")
      .all(profileId) as { id: number; name: string; bytes: number; chars: number; created_at: number }[];
  }

  docs(profileId: number): PersonaDoc[] {
    return this.db.prepare("SELECT name, text FROM persona_files WHERE profile_id = ? ORDER BY id").all(profileId) as unknown as PersonaDoc[];
  }

  addFile(profileId: number, name: string, text: string, bytes: number) {
    const r = this.db
      .prepare("INSERT INTO persona_files (profile_id, name, text, bytes, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(profileId, name, text, bytes, Date.now());
    return Number(r.lastInsertRowid);
  }

  file(id: number) {
    return this.db.prepare("SELECT id, profile_id, name, text FROM persona_files WHERE id = ?").get(id) as
      | { id: number; profile_id: number; name: string; text: string }
      | undefined;
  }

  removeFile(id: number) {
    this.db.prepare("DELETE FROM persona_files WHERE id = ?").run(id);
  }

  // ---------- Nhãn tắt bot của tài khoản ----------
  offTag(accountId: number): string {
    const r = this.db.prepare("SELECT off_tag FROM accounts WHERE id = ?").get(accountId) as { off_tag: string } | undefined;
    return r?.off_tag || "Không bot";
  }

  /**
   * Sao chép tính cách (kèm tài liệu) sang tài khoản khác. Tính cách trùng tên nhãn ở nơi
   * nhận sẽ được ghi đè nội dung; tính cách mới thì tạo thêm.
   */
  copyToAccount(profileIds: number[], toAccountId: number): { created: number; updated: number } {
    let created = 0;
    let updated = 0;
    this.db.exec("BEGIN");
    try {
      for (const id of profileIds) {
        const p = this.get(id);
        if (!p || p.accountId === toAccountId) continue;
        const existing = this.list(toAccountId).find(
          (x) => (p.tag && x.tag.toLocaleLowerCase("vi") === p.tag.toLocaleLowerCase("vi")) || (!p.tag && x.name === p.name),
        );
        const now = Date.now();
        let targetId: number;
        if (existing) {
          this.db
            .prepare("UPDATE profiles SET name = ?, identity = ?, send_mode = ?, applies = ?, priority = ?, updated_at = ? WHERE id = ?")
            .run(p.name, JSON.stringify(p.identity), p.sendMode, p.applies, p.priority, now, existing.id);
          this.db.prepare("DELETE FROM persona_files WHERE profile_id = ?").run(existing.id);
          this.db.prepare("DELETE FROM profile_faqs WHERE profile_id = ?").run(existing.id);
          this.db.prepare("DELETE FROM profile_notes WHERE profile_id = ?").run(existing.id);
          targetId = existing.id;
          updated++;
        } else {
          const r = this.db
            .prepare(
              `INSERT INTO profiles (account_id, name, tag, identity, send_mode, applies, priority, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(toAccountId, p.name, p.tag, JSON.stringify(p.identity), p.sendMode, p.applies, p.priority, now, now);
          targetId = Number(r.lastInsertRowid);
          created++;
        }
        this.db
          .prepare(
            `INSERT INTO persona_files (profile_id, name, text, bytes, created_at)
             SELECT ?, name, text, bytes, ? FROM persona_files WHERE profile_id = ? ORDER BY id`,
          )
          .run(targetId, now, id);
        this.db
          .prepare("INSERT INTO profile_faqs (profile_id, question, answer, updated_at) SELECT ?, question, answer, ? FROM profile_faqs WHERE profile_id = ? ORDER BY id")
          .run(targetId, now, id);
        this.db
          .prepare(
            "INSERT INTO profile_notes (profile_id, text, expires_on, created_at, updated_at) SELECT ?, text, expires_on, ?, ? FROM profile_notes WHERE profile_id = ? ORDER BY id",
          )
          .run(targetId, now, now, id);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return { created, updated };
  }
}

export type ResolvedProfile =
  | { kind: "profile"; profile: Profile; source: "web" | "zalo"; conflict: Profile[] }
  | { kind: "off"; source: "web" | "zalo" }
  | { kind: "none" };

/**
 * Hội thoại này đang dùng tính cách nào (docs/quyen-tro-ly.md, mục A3):
 * 1. Gắn trên trang quản trị thắng nhãn Zalo ("Tắt bot" hoặc một tính cách).
 * 2. Nhãn "Không bot" trong Zalo → tắt.
 * 3. Nhãn trùng tag của tính cách → tính cách ưu tiên cao nhất; còn lại là xung đột.
 * 4. Không có gì → không trả lời.
 * `labels` = null nghĩa là không đọc được nhãn Zalo → coi như không có nhãn.
 */
export function resolveProfile(
  conv: { thread_id: string; thread_type: "user" | "group"; assigned_profile_id: number | null; assigned_off: number },
  profiles: Profile[],
  labels: unknown,
  offTag: string,
): ResolvedProfile {
  if (conv.assigned_off) return { kind: "off", source: "web" };
  if (conv.assigned_profile_id !== null) {
    const p = profiles.find((x) => x.id === conv.assigned_profile_id);
    if (p) return { kind: "profile", profile: p, source: "web", conflict: [] };
  }
  if (!labels) return { kind: "none" };
  if (offTag && conversationHasLabel(labels, offTag, conv.thread_id)) return { kind: "off", source: "zalo" };
  const matched = profiles
    .filter((p) => p.tag && conversationHasLabel(labels, p.tag, conv.thread_id))
    .filter((p) => p.applies === "both" || p.applies === conv.thread_type)
    .sort((a, b) => a.priority - b.priority || a.id - b.id);
  if (!matched.length) return { kind: "none" };
  return { kind: "profile", profile: matched[0], source: "zalo", conflict: matched.slice(1) };
}
