import os from "node:os";
import type { FastifyInstance } from "fastify";

/**
 * Báo lỗi / góp ý: chuyển tới Google Sheet của người giữ repo (Apps Script web app).
 * Chỉ gửi khi người dùng bấm Gửi, và chỉ những gì họ để tích (ảnh chụp, thông tin máy, số liên hệ).
 * Địa chỉ nhận: CDN_FEEDBACK_URL hoặc trường "feedbackUrl" trong package.json (bản fork tự đặt của mình).
 */
export interface FeedbackDeps {
  url: string | null;
  version: string;
  installKind: string;
  fetch?: typeof fetch;
}

const MAX_SHOT_BYTES = 4 * 1024 * 1024;

export function registerFeedbackRoutes(app: FastifyInstance, deps: FeedbackDeps) {
  app.get("/api/feedback/config", async () => ({ enabled: Boolean(deps.url) }));

  app.post<{
    Body: { kind?: string; message?: string; contact?: string; includeInfo?: boolean; page?: string; userAgent?: string; screenshot?: string };
  }>("/api/feedback", { bodyLimit: Math.ceil(MAX_SHOT_BYTES * 1.4) + 100_000 }, async (req, reply) => {
    if (!deps.url) return reply.code(400).send({ error: "Bản này chưa đặt nơi nhận báo lỗi." });
    const b = req.body ?? {};
    const message = String(b.message ?? "").trim().slice(0, 5000);
    if (message.length < 5) return reply.code(400).send({ error: "Bạn viết thêm vài chữ mô tả nhé." });
    const shot = typeof b.screenshot === "string" ? b.screenshot.replace(/^data:image\/\w+;base64,/, "") : "";
    if (shot && shot.length * 0.75 > MAX_SHOT_BYTES) return reply.code(400).send({ error: "Ảnh chụp quá lớn." });

    const payload = {
      kind: b.kind === "idea" ? "Góp ý" : "Báo lỗi",
      message,
      contact: String(b.contact ?? "").trim().slice(0, 100),
      ...(b.includeInfo
        ? {
            version: deps.version,
            installKind: deps.installKind,
            system: `${os.type()} ${os.release()} (${process.arch}), Node ${process.versions.node}`,
            page: String(b.page ?? "").slice(0, 200),
            browser: String(b.userAgent ?? "").slice(0, 300),
          }
        : {}),
      screenshot: shot,
      sentAt: new Date().toISOString(),
    };
    try {
      // text/plain: Apps Script đọc e.postData.contents; tránh bước "preflight" không cần thiết.
      const res = await (deps.fetch ?? fetch)(deps.url, {
        method: "POST",
        headers: { "content-type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      let ok = res.ok;
      try {
        ok = ok && JSON.parse(text).ok !== false;
      } catch {
        /* Apps Script trả trang HTML khi lỗi */
        ok = false;
      }
      if (!ok) throw new Error(`nơi nhận trả lỗi ${res.status}`);
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, "Không gửi được báo lỗi");
      return reply.code(502).send({ error: "Chưa gửi được. Kiểm tra mạng rồi thử lại sau ít phút." });
    }
    return { ok: true };
  });
}
