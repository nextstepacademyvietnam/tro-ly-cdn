import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { describeRecurrence, vnHour } from "../../scheduler/recurrence.js";
import type { ScheduleRunner } from "../../scheduler/runner.js";
import { MAX_IMAGE_BYTES, type Schedule, ScheduleError, type ScheduleInput, type ScheduleStatus, type ScheduleStore } from "../../scheduler/store.js";

export interface ScheduleDeps {
  store: ScheduleStore;
  runner: ScheduleRunner;
}

const STATUSES: ScheduleStatus[] = ["active", "paused", "cancelled", "done"];

export function registerScheduleRoutes(app: FastifyInstance, { store, runner }: ScheduleDeps) {
  const bad = (err: unknown) => {
    if (err instanceof ScheduleError || err instanceof Error) {
      return Object.assign(new Error(err.message), { statusCode: err instanceof ScheduleError ? 400 : 409 });
    }
    return err;
  };

  /** Lịch phải thuộc tài khoản đang chọn. */
  const own = (accountId: number, id: number): Schedule => {
    const s = store.get(id);
    if (!s || s.accountId !== accountId) throw Object.assign(new Error("Không có lịch này"), { statusCode: 404 });
    return s;
  };

  const view = (s: Schedule) => {
    const runs = store.runs(s.id, 200);
    return {
      ...s,
      summary: describeRecurrence(s.recurrence),
      quietHours: s.nextRunAt !== null && (vnHour(s.nextRunAt) >= 22 || vnHour(s.nextRunAt) < 7),
      images: s.imageIds.map((id) => ({ id, url: `/api/media/${id}` })),
      stats: {
        sent: runs.filter((r) => r.status === "sent").length,
        failed: runs.filter((r) => r.status === "failed").length,
        missed: runs.filter((r) => r.status === "missed").length,
      },
      lastRuns: runs.slice(0, 5),
    };
  };

  // ---------- Ảnh ----------
  app.post<{ Body: { name?: string; dataBase64?: string } }>(
    "/api/media",
    { bodyLimit: Math.ceil(MAX_IMAGE_BYTES * 1.4) },
    async (req, reply) => {
      if (!req.body?.name || !req.body.dataBase64) return reply.code(400).send({ error: "Thiếu ảnh" });
      try {
        const m = store.saveImage(req.body.name, Buffer.from(req.body.dataBase64, "base64"));
        return { id: m.id, url: `/api/media/${m.id}`, name: m.name };
      } catch (err) {
        throw bad(err);
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/media/:id", async (req, reply) => {
    const m = store.media(Number(req.params.id));
    if (!m) return reply.code(404).send({ error: "Không có ảnh này" });
    reply.header("cache-control", "private, max-age=86400").type(m.mime);
    return reply.send(fs.createReadStream(store.mediaPath(m)));
  });

  // ---------- Lịch ----------
  app.get<{ Querystring: { thread?: string; status?: string } }>("/api/schedules", async (req) => {
    const status = STATUSES.includes(req.query.status as ScheduleStatus) ? (req.query.status as ScheduleStatus) : undefined;
    return { schedules: store.list({ accountId: req.accountId, threadId: req.query.thread || undefined, status }).map(view) };
  });

  app.get<{ Params: { id: string } }>("/api/schedules/:id", async (req) => {
    const s = own(req.accountId, Number(req.params.id));
    return { schedule: view(s), runs: store.runs(s.id) };
  });

  app.post<{ Body: ScheduleInput }>("/api/schedules", async (req) => {
    try {
      return { schedule: view(store.create({ ...req.body, accountId: req.accountId })) };
    } catch (err) {
      throw bad(err);
    }
  });

  app.put<{ Params: { id: string }; Body: ScheduleInput }>("/api/schedules/:id", async (req) => {
    own(req.accountId, Number(req.params.id));
    try {
      return { schedule: view(store.update(Number(req.params.id), req.body)) };
    } catch (err) {
      throw bad(err);
    }
  });

  const statusAction = (path: string, status: ScheduleStatus) =>
    app.post<{ Params: { id: string } }>(`/api/schedules/:id/${path}`, async (req) => {
      own(req.accountId, Number(req.params.id));
      try {
        return { schedule: view(store.setStatus(Number(req.params.id), status)) };
      } catch (err) {
        throw bad(err);
      }
    });
  statusAction("pause", "paused");
  statusAction("resume", "active");
  statusAction("cancel", "cancelled");

  app.post<{ Params: { id: string } }>("/api/schedules/:id/duplicate", async (req) => {
    own(req.accountId, Number(req.params.id));
    try {
      return { schedule: view(store.duplicate(Number(req.params.id))) };
    } catch (err) {
      throw bad(err);
    }
  });

  app.post<{ Params: { id: string } }>("/api/schedules/:id/send-now", async (req) => {
    own(req.accountId, Number(req.params.id));
    try {
      await runner.sendNow(Number(req.params.id));
      return { schedule: view(store.get(Number(req.params.id))!) };
    } catch (err) {
      throw bad(err);
    }
  });

  app.post<{ Params: { runId: string } }>("/api/schedule-runs/:runId/retry", async (req) => {
    const run = store.run(Number(req.params.runId));
    if (run) own(req.accountId, run.scheduleId);
    try {
      await runner.retry(Number(req.params.runId));
      return { ok: true };
    } catch (err) {
      throw bad(err);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/schedules/:id", async (req) => {
    own(req.accountId, Number(req.params.id));
    store.remove(Number(req.params.id));
    return { ok: true };
  });
}
