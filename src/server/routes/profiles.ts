import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AccountManager } from "../../channels/zalo/accounts.js";
import { DocumentError, MAX_FILE_BYTES, extractText } from "../../core/documents.js";
import { MAX_PROMPT_CHARS, type Profile, ProfileError, type ProfileInput, type ProfileStore } from "../../core/profiles.js";
import {
  type Faq,
  type Identity,
  type TimelyNote,
  identityToText,
  parseIdentity,
  textToIdentity,
  vnToday,
  vnTodayLabel,
} from "../../core/promptLayers.js";
import { frameSystemPrompt } from "../../core/replyPolicy.js";
import { type ChatMessage, type Engine } from "../../engines/index.js";

const PROPOSAL_RE = /<huong_dan_moi>\s*([\s\S]*?)\s*<\/huong_dan_moi>/i;
const NOTE_RE = /<thoi_diem(?:\s+han="(\d{4}-\d{2}-\d{2})")?\s*>\s*([\s\S]*?)\s*<\/thoi_diem>/gi;
const FAQ_RE = /<hoi_dap>\s*<hoi>\s*([\s\S]*?)\s*<\/hoi>\s*<dap>\s*([\s\S]*?)\s*<\/dap>\s*<\/hoi_dap>/gi;

export interface OptimizerReply {
  message: string;
  /** Tầng 1 đề xuất (đủ các ô) — null nếu AI chưa đề xuất. */
  proposal: Identity | null;
  /** Gợi ý thêm vào tầng 3. */
  notes: TimelyNote[];
  /** Gợi ý thêm vào tầng 2. */
  faqs: Faq[];
}

/** Tách các đề xuất (tầng 1 / ghi chú tầng 3 / hỏi đáp tầng 2) khỏi phần lời chat. */
export function parseOptimizerReply(reply: string): OptimizerReply {
  const m = PROPOSAL_RE.exec(reply);
  const notes = [...reply.matchAll(NOTE_RE)].map((x) => ({ text: x[2].trim(), expiresOn: x[1] ?? null })).filter((n) => n.text);
  const faqs = [...reply.matchAll(FAQ_RE)].map((x) => ({ question: x[1].trim(), answer: x[2].trim() })).filter((f) => f.question && f.answer);
  const message = reply
    .replace(PROPOSAL_RE, "")
    .replace(NOTE_RE, "")
    .replace(FAQ_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    message: message || (m ? "Đây là bản hướng dẫn mới:" : notes.length || faqs.length ? "Gợi ý của mình:" : ""),
    proposal: m ? textToIdentity(m[1]) : null,
    notes,
    faqs,
  };
}

export function optimizerSystemPrompt(p: Pick<Profile, "name" | "tag">, identity: Identity, fileNames: string[], faqCount: number, now = Date.now()): string {
  return [
    "Bạn là chuyên gia viết hướng dẫn cho trợ lý AI trả lời tin nhắn Zalo thay cho chủ tài khoản.",
    `Bạn đang giúp chủ cải thiện tính cách "${p.name}"${p.tag ? ` (gắn với nhãn Zalo "${p.tag}")` : ""}. Hôm nay là ${vnTodayLabel(now)} (${vnToday(now)}).`,
    "",
    "Hướng dẫn chia 4 tầng theo mức độ thay đổi — luôn đặt thông tin vào ĐÚNG tầng:",
    "- Tầng 0 · Luật an toàn: app giữ cố định (không bịa giá, không xác nhận tiền, chuyển người thật khi cần…). Không viết lại.",
    "- Tầng 1 · Danh tính & nguyên tắc (ít đổi, vài tháng): các ô bên dưới. Chỉ những điều bền vững.",
    "- Tầng 2 · Kiến thức sản phẩm (thỉnh thoảng): tài liệu + câu hỏi thường gặp. Giá, chính sách, quy trình nằm ở đây, KHÔNG ở tầng 1.",
    "- Tầng 3 · Thông tin thời điểm (thường xuyên): khuyến mãi, lịch khai giảng, số chỗ còn, nghỉ lễ… luôn có ngày hết hạn.",
    "",
    "Cách làm việc:",
    "- Nói tiếng Việt, ngắn gọn, thân thiện, không thuật ngữ kỹ thuật. Chưa rõ thì hỏi lại tối đa 2 câu.",
    "- Chủ dán đoạn chat bị trả lời sai: chỉ ra vì sao, rồi sửa ở đúng tầng.",
    "- Thấy thông tin đặt sai tầng (VD khuyến mãi tháng này nằm ở tầng 1) thì nói rõ và đề xuất chuyển.",
    "",
    "Cách đề xuất (app sẽ hiện nút để chủ bấm áp dụng):",
    "- Sửa tầng 1: viết 2–5 gạch đầu dòng tóm tắt thay đổi, rồi đưa TOÀN BỘ tầng 1 mới giữa <huong_dan_moi> và </huong_dan_moi>,",
    "  mỗi ô bắt đầu bằng đúng tiêu đề \"### <tên ô>\" như bên dưới (ô không có gì thì để trống).",
    '- Thêm thông tin thời điểm (tầng 3): <thoi_diem han="YYYY-MM-DD">nội dung</thoi_diem> (bỏ han nếu không có hạn).',
    "- Thêm câu hỏi thường gặp (tầng 2): <hoi_dap><hoi>câu hỏi</hoi><dap>câu trả lời</dap></hoi_dap>.",
    "",
    "Luật khi viết:",
    "- Giữ đúng ý, giọng và các điều cấm của chủ. Không tự thêm giá, chính sách, số liệu, lời hứa không có sẵn.",
    "- Câu dặn cụ thể, có ví dụ ngắn khi cần. Tránh viết hoa toàn bộ và lời dặn mơ hồ.",
    `- Tầng 1 tối đa ${MAX_PROMPT_CHARS.toLocaleString("vi-VN")} ký tự.`,
    "",
    "<tang_1_hien_tai>",
    identityToText(identity),
    "</tang_1_hien_tai>",
    "",
    `Tầng 2 hiện có: ${fileNames.length ? `tài liệu ${fileNames.join(", ")}` : "chưa có tài liệu"}; ${faqCount} câu hỏi thường gặp.`,
  ].join("\n");
}

export function registerProfileRoutes(app: FastifyInstance, profiles: ProfileStore, accounts: AccountManager, engine: () => Engine | null) {
  const bad = (err: unknown, code = 400) => Object.assign(new Error((err as Error).message), { statusCode: code });

  /** Tính cách phải thuộc tài khoản đang chọn. */
  const own = (req: FastifyRequest, id: number): Profile => {
    const p = profiles.get(id);
    if (!p || p.accountId !== req.accountId) throw bad(new Error("Không có tính cách này"), 404);
    return p;
  };
  const needEngine = (): Engine => {
    const e = engine();
    if (!e) throw bad(new Error("Chưa cấu hình mô hình AI"));
    return e;
  };
  const cleanMessages = (list: ChatMessage[] | undefined) =>
    (list ?? []).filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string").slice(-30);
  const guard = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      throw err instanceof ProfileError ? bad(err) : err;
    }
  };

  /** Toàn bộ hướng dẫn AI nhận (tầng 0–3), giống hệt lúc trả lời khách thật trong chat riêng. */
  const fullPrompt = (req: FastifyRequest, p: Profile, identity?: Identity) => {
    const frame = frameSystemPrompt({
      ownerName: accounts.row(req.accountId)?.name || "chủ tài khoản",
      profileName: p.name,
      isGroup: false,
      groupName: "",
      personName: "khách",
      sendMode: p.sendMode,
    });
    return { frame, layers: profiles.compose(p.id, identity), system: `${frame}\n\n${profiles.compose(p.id, identity)}` };
  };
  const draftIdentity = (raw: unknown) => (raw && typeof raw === "object" ? parseIdentity(raw) : undefined);

  app.get("/api/profiles", async (req) => ({
    offTag: profiles.offTag(req.accountId),
    today: vnToday(),
    profiles: profiles.list(req.accountId).map((p) => ({
      ...p,
      files: profiles.files(p.id),
      faqs: profiles.faqs(p.id),
      notes: profiles.notes(p.id),
    })),
  }));

  app.post<{ Body: ProfileInput }>("/api/profiles", async (req) => ({ profile: guard(() => profiles.create(req.accountId, req.body)) }));

  app.put<{ Params: { id: string }; Body: ProfileInput }>("/api/profiles/:id", async (req) => {
    own(req, Number(req.params.id));
    return { profile: guard(() => profiles.update(Number(req.params.id), req.body)) };
  });

  app.delete<{ Params: { id: string } }>("/api/profiles/:id", async (req) => {
    own(req, Number(req.params.id));
    profiles.remove(Number(req.params.id));
    return { ok: true };
  });

  /** Xem hướng dẫn AI nhận được (có thể kèm tầng 1 đang soạn). */
  app.post<{ Params: { id: string }; Body: { identity?: Partial<Identity> } }>("/api/profiles/:id/preview", async (req) => {
    const p = own(req, Number(req.params.id));
    return fullPrompt(req, p, draftIdentity(req.body?.identity));
  });

  // ---------- Tầng 2: tài liệu ----------
  app.post<{ Params: { id: string }; Body: { name?: string; dataBase64?: string } }>(
    "/api/profiles/:id/files",
    { bodyLimit: Math.ceil(MAX_FILE_BYTES * 1.4) },
    async (req, reply) => {
      const p = own(req, Number(req.params.id));
      const name = (req.body?.name ?? "").split(/[\\/]/).pop()?.trim().slice(0, 200) ?? "";
      if (!name || !req.body?.dataBase64) return reply.code(400).send({ error: "Thiếu file" });
      const data = Buffer.from(req.body.dataBase64, "base64");
      try {
        const text = await extractText(name, data);
        const id = profiles.addFile(p.id, name, text, data.length);
        return { id, name, chars: text.length };
      } catch (err) {
        if (err instanceof DocumentError) return reply.code(400).send({ error: err.message });
        throw err;
      }
    },
  );

  /** Rút chữ từ file mà không lưu — dùng cho "Nạp từ file". */
  app.post<{ Body: { name?: string; dataBase64?: string } }>("/api/extract-text", { bodyLimit: Math.ceil(MAX_FILE_BYTES * 1.4) }, async (req, reply) => {
    const name = (req.body?.name ?? "").split(/[\\/]/).pop() ?? "";
    if (!name || !req.body?.dataBase64) return reply.code(400).send({ error: "Thiếu file" });
    try {
      return { text: await extractText(name, Buffer.from(req.body.dataBase64, "base64")) };
    } catch (err) {
      if (err instanceof DocumentError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  const ownFile = (req: FastifyRequest, id: number) => {
    const f = profiles.file(id);
    if (!f) throw bad(new Error("Không có file này"), 404);
    own(req, f.profile_id);
    return f;
  };
  app.get<{ Params: { id: string } }>("/api/profile-files/:id", async (req) => ownFile(req, Number(req.params.id)));
  app.delete<{ Params: { id: string } }>("/api/profile-files/:id", async (req) => {
    ownFile(req, Number(req.params.id));
    profiles.removeFile(Number(req.params.id));
    return { ok: true };
  });

  // ---------- Tầng 2: hỏi đáp ----------
  app.post<{ Params: { id: string }; Body: Faq }>("/api/profiles/:id/faqs", async (req) => {
    const p = own(req, Number(req.params.id));
    return { id: guard(() => profiles.saveFaq(p.id, req.body ?? { question: "", answer: "" })) };
  });
  app.put<{ Params: { id: string; fid: string }; Body: Faq }>("/api/profiles/:id/faqs/:fid", async (req) => {
    const p = own(req, Number(req.params.id));
    return { id: guard(() => profiles.saveFaq(p.id, req.body ?? { question: "", answer: "" }, Number(req.params.fid))) };
  });
  app.delete<{ Params: { id: string; fid: string } }>("/api/profiles/:id/faqs/:fid", async (req) => {
    const p = own(req, Number(req.params.id));
    profiles.removeFaq(p.id, Number(req.params.fid));
    return { ok: true };
  });

  // ---------- Tầng 3: ghi chú có hạn ----------
  app.post<{ Params: { id: string }; Body: TimelyNote }>("/api/profiles/:id/notes", async (req) => {
    const p = own(req, Number(req.params.id));
    return { id: guard(() => profiles.saveNote(p.id, req.body ?? { text: "", expiresOn: null })) };
  });
  app.put<{ Params: { id: string; nid: string }; Body: TimelyNote }>("/api/profiles/:id/notes/:nid", async (req) => {
    const p = own(req, Number(req.params.id));
    return { id: guard(() => profiles.saveNote(p.id, req.body ?? { text: "", expiresOn: null }, Number(req.params.nid))) };
  });
  app.delete<{ Params: { id: string; nid: string } }>("/api/profiles/:id/notes/:nid", async (req) => {
    const p = own(req, Number(req.params.id));
    profiles.removeNote(p.id, Number(req.params.nid));
    return { ok: true };
  });

  // ---------- Chat thử: dùng đúng hướng dẫn thật (tầng 0–3), tầng 1 có thể là bản đang soạn ----------
  app.post<{ Params: { id: string }; Body: { messages?: ChatMessage[]; identity?: Partial<Identity> } }>("/api/profiles/:id/chat", async (req, reply) => {
    const p = own(req, Number(req.params.id));
    const messages = cleanMessages(req.body?.messages);
    if (messages.at(-1)?.role !== "user") return reply.code(400).send({ error: "Thiếu tin nhắn" });
    const text = await needEngine().generate({ system: fullPrompt(req, p, draftIdentity(req.body?.identity)).system, messages });
    return { reply: text };
  });

  // ---------- Trò chuyện với AI để tối ưu hướng dẫn ----------
  app.post<{ Params: { id: string }; Body: { messages?: ChatMessage[]; identity?: Partial<Identity> } }>("/api/profiles/:id/optimize", async (req, reply) => {
    const p = own(req, Number(req.params.id));
    const messages = cleanMessages(req.body?.messages);
    if (messages.at(-1)?.role !== "user") return reply.code(400).send({ error: "Thiếu tin nhắn" });
    const identity = draftIdentity(req.body?.identity) ?? p.identity;
    const system = optimizerSystemPrompt(p, identity, profiles.files(p.id).map((f) => f.name), profiles.faqs(p.id).length);
    const raw = await needEngine().generate({ system, messages });
    return { raw, ...parseOptimizerReply(raw) };
  });

  // ---------- Sao chép sang tài khoản khác ----------
  app.post<{ Body: { profileIds?: number[]; toAccountId?: number } }>("/api/profiles/copy", async (req, reply) => {
    const to = Number(req.body?.toAccountId);
    if (!accounts.row(to)) return reply.code(400).send({ error: "Chọn tài khoản nhận" });
    if (to === req.accountId) return reply.code(400).send({ error: "Tài khoản nhận phải khác tài khoản hiện tại" });
    const ids = (req.body?.profileIds ?? []).map(Number);
    if (!ids.length) return reply.code(400).send({ error: "Chọn ít nhất một tính cách" });
    for (const id of ids) own(req, id);
    return profiles.copyToAccount(ids, to);
  });

  // ---------- AI viết giúp nội dung lịch hẹn ----------
  app.post<{ Body: { brief?: string; profileId?: number } }>("/api/schedules/ai-draft", async (req, reply) => {
    const brief = (req.body?.brief ?? "").trim().slice(0, 2000);
    if (!brief) return reply.code(400).send({ error: "Nhập yêu cầu, ví dụ: nhắc lịch học tối nay 20h" });
    const list = profiles.list(req.accountId);
    const p = list.find((x) => x.id === Number(req.body?.profileId)) ?? list[0];
    const base = p ? profiles.compose(p.id) : "Bạn là trợ lý nhắn tin Zalo, nói tiếng Việt tự nhiên.";
    const system =
      base +
      "\n\nViệc bây giờ: viết MỘT tin nhắn Zalo theo yêu cầu của chủ, để gửi theo lịch cho khách hoặc nhóm. " +
      "Chỉ trả về đúng nội dung tin nhắn, không lời dẫn, không markdown, không ngoặc kép bao quanh. Ngắn gọn, tự nhiên.";
    const text = await needEngine().generate({ system, messages: [{ role: "user", content: brief }] });
    return { text };
  });
}
