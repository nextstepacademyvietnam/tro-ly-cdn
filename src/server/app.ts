import fs from "node:fs";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { Auth, LoginLimiter } from "./auth.js";
import type { DB } from "./db.js";
import { Settings } from "./settings.js";
import type { SecretBox } from "./secrets.js";
import os from "node:os";
import path from "node:path";
import { AccountManager } from "../channels/zalo/accounts.js";
import { ProfileStore } from "../core/profiles.js";
import { ScheduleRunner } from "../scheduler/runner.js";
import { ScheduleStore } from "../scheduler/store.js";
import { registerAccountRoutes } from "./routes/zalo.js";
import { registerProfileRoutes } from "./routes/profiles.js";
import { registerAssistantRoutes } from "./routes/assistant.js";
import { AssistantStore } from "../core/assistantStore.js";
import { Replier } from "../core/replier.js";
import { checkLayerReminders } from "../core/layerReminder.js";
import { type ScheduleDeps, registerScheduleRoutes } from "./routes/schedules.js";
import type { Updater } from "./updates.js";
import {
  type EngineConfig,
  type EngineKind,
  EngineError,
  OPENAI_COMPATIBLE_PRESETS,
  checkEngine,
  createEngine,
} from "../engines/index.js";

const COOKIE = "cdn_sid";
const ENGINE_KEY = "engine";
const KINDS: EngineKind[] = ["claude-code", "codex", "openai-compatible", "anthropic-api"];

export interface AppDeps {
  db: DB;
  box: SecretBox;
  /** Thư mục dữ liệu (khoá Zalo, ảnh). Bỏ trống khi test: dùng thư mục tạm. */
  dataDir?: string;
  webDir?: string;
  secureCookies?: boolean;
  accounts?: AccountManager;
  profiles?: ProfileStore;
  schedules?: ScheduleDeps;
  /** Gom tin trước khi AI trả lời (ms). Test đặt 0. */
  replyBatchMs?: number;
  /** Bộ kiểm tra / cài bản mới. Không có thì các route cập nhật báo "không hỗ trợ". */
  updater?: Updater;
  /** Số bản hiện trong /api/status. */
  version?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user: { id: number; username: string } | null;
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, bodyLimit: 1_000_000 });
  const auth = new Auth(deps.db);
  const settings = new Settings(deps.db, deps.box);
  const limiter = new LoginLimiter();
  const dataDir = deps.dataDir ?? path.join(os.tmpdir(), "tro-ly-cdn-test");
  const accounts = deps.accounts ?? new AccountManager(deps.db, settings, dataDir);
  const profiles = deps.profiles ?? new ProfileStore(deps.db);
  const schedules: ScheduleDeps = deps.schedules ?? (() => {
    const store = new ScheduleStore(deps.db, dataDir);
    return { store, runner: new ScheduleRunner(store, accounts) };
  })();

  await app.register(fastifyCookie);
  app.decorateRequest("user", null);

  const setSession = (reply: import("fastify").FastifyReply, token: string) =>
    reply.setCookie(COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: deps.secureCookies ?? false,
      maxAge: 30 * 86_400,
    });

  const PUBLIC = new Set(["/api/status", "/api/setup", "/api/login"]);
  app.addHook("onRequest", async (req, reply) => {
    req.user = auth.userForToken(req.cookies[COOKIE]);
    const url = req.url.split("?")[0];
    if (url.startsWith("/api/") && !PUBLIC.has(url) && !req.user) {
      return reply.code(401).send({ error: "Cần đăng nhập" });
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof EngineError) return reply.code(502).send({ error: err.message, hint: (err as EngineError).hint });
    const code = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (code === 500) app.log.error(err);
    return reply.code(code).send({ error: code === 500 ? "Lỗi máy chủ" : err.message });
  });

  // ---------- Tài khoản ----------
  app.get("/api/status", async (req) => ({
    hasAdmin: auth.hasAdmin(),
    user: req.user ? { username: req.user.username } : null,
    version: deps.version ?? "",
  }));

  app.post<{ Body: { username?: string; password?: string } }>("/api/setup", async (req, reply) => {
    if (auth.hasAdmin()) return reply.code(409).send({ error: "Đã có tài khoản quản trị" });
    try {
      const id = auth.createAdmin(req.body?.username ?? "", req.body?.password ?? "");
      setSession(reply, auth.startSession(id));
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post<{ Body: { username?: string; password?: string } }>("/api/login", async (req, reply) => {
    if (limiter.blocked(req.ip)) {
      return reply.code(429).send({ error: "Sai mật khẩu quá nhiều lần, thử lại sau 15 phút" });
    }
    const token = auth.login(req.body?.username ?? "", req.body?.password ?? "");
    if (!token) {
      limiter.fail(req.ip);
      return reply.code(401).send({ error: "Sai tên đăng nhập hoặc mật khẩu" });
    }
    limiter.reset(req.ip);
    setSession(reply, token);
    return { ok: true };
  });

  app.post("/api/logout", async (req, reply) => {
    auth.logout(req.cookies[COOKIE]);
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  // ---------- Mô hình AI ----------
  const loadEngine = (): EngineConfig | undefined => settings.getSecret<EngineConfig>(ENGINE_KEY);

  /** Gộp cấu hình mới với cái đã lưu: ô API key để trống nghĩa là giữ key cũ. */
  const mergeEngine = (incoming: Partial<EngineConfig>): EngineConfig => {
    if (!incoming.kind || !KINDS.includes(incoming.kind)) {
      throw Object.assign(new Error("Chọn một loại mô hình hợp lệ"), { statusCode: 400 });
    }
    const saved = loadEngine();
    const keepKey = !incoming.apiKey && saved?.kind === incoming.kind ? saved.apiKey : undefined;
    return {
      kind: incoming.kind,
      model: clean(incoming.model),
      baseUrl: clean(incoming.baseUrl),
      cliPath: clean(incoming.cliPath),
      apiKey: clean(incoming.apiKey) ?? keepKey,
    };
  };

  app.get("/api/engine", async () => {
    const cfg = loadEngine();
    return {
      config: cfg ? { ...cfg, apiKey: undefined, hasApiKey: Boolean(cfg.apiKey) } : null,
      presets: OPENAI_COMPATIBLE_PRESETS,
    };
  });

  app.put<{ Body: Partial<EngineConfig> }>("/api/engine", async (req) => {
    settings.setSecret(ENGINE_KEY, mergeEngine(req.body ?? {}));
    return { ok: true };
  });

  app.post<{ Body: Partial<EngineConfig> }>("/api/engine/check", async (req) => {
    return checkEngine(mergeEngine(req.body ?? {}));
  });

  // ---------- Tài khoản Zalo, tính cách, lịch ----------
  const engineOrNull = () => {
    const cfg = loadEngine();
    return cfg ? createEngine(cfg) : null;
  };
  const assistant = new AssistantStore(deps.db);
  const replier = new Replier(profiles, assistant, (id) => accounts.replierAccount(id), engineOrNull, {
    batchMs: deps.replyBatchMs,
    log: (msg, extra) => app.log.warn(extra ?? {}, msg),
  });
  accounts.setReplier(replier);
  // Nhắc giữ tầng 3 luôn mới: kiểm mỗi giờ (không chạy khi test).
  const reminderTimer = deps.dataDir ? setInterval(() => checkLayerReminders(deps.db, assistant), 3_600_000) : null;
  if (deps.dataDir) setTimeout(() => checkLayerReminders(deps.db, assistant), 30_000).unref();
  app.addHook("onClose", async () => {
    replier.dispose();
    if (reminderTimer) clearInterval(reminderTimer);
  });

  registerAccountRoutes(app, accounts, profiles, assistant, schedules.store);
  registerProfileRoutes(app, profiles, accounts, engineOrNull);
  registerScheduleRoutes(app, schedules);
  registerAssistantRoutes(app, accounts, assistant, replier);

  // ---------- Cập nhật ----------
  const updater = deps.updater;
  app.get("/api/update", async () =>
    updater
      ? updater.status()
      : { current: deps.version ?? "", latest: null, notes: "", url: "", publishedAt: "", important: false, canSelfUpdate: false, checkedAt: 0, checkEnabled: false, state: "idle", error: "", lastResult: null },
  );
  app.post("/api/update/check", async (_req, reply) => {
    if (!updater) return reply.code(400).send({ error: "Bản này không kiểm tra cập nhật" });
    try {
      await updater.check();
    } catch (err) {
      return reply.code(502).send({ error: `Không hỏi được GitHub: ${(err as Error).message}` });
    }
    return updater.status();
  });
  app.post("/api/update/apply", async (_req, reply) => {
    if (!updater) return reply.code(400).send({ error: "Bản này không tự cập nhật" });
    try {
      updater.apply();
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
    return updater.status();
  });
  app.post("/api/update/dismiss-result", async () => {
    updater?.dismissResult();
    return { ok: true };
  });
  app.addHook("onClose", async () => updater?.stop());

  // ---------- Giao diện web ----------
  if (deps.webDir && fs.existsSync(deps.webDir)) {
    await app.register(fastifyStatic, { root: deps.webDir });
    app.setNotFoundHandler((req: FastifyRequest, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/")) return reply.sendFile("index.html");
      return reply.code(404).send({ error: "Không tìm thấy" });
    });
  }

  return app;
}

function clean(v: string | undefined): string | undefined {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : undefined;
}
