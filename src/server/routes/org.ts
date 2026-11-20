import type { FastifyInstance } from "fastify";
import type { OrgConnection } from "../../org/connection.js";

/** Kết nối doanh nghiệp: nối app trên máy với công ty (Supabase), xem trạng thái, ngắt kết nối. */
export function registerOrgRoutes(app: FastifyInstance, org: OrgConnection) {
  const fail = (err: unknown, code = 400) => Object.assign(new Error((err as Error).message), { statusCode: code });

  app.get("/api/org", async () => org.status());

  app.post<{ Body: { code?: string; email?: string } }>("/api/org/start", async (req) => {
    try {
      await org.begin(String(req.body?.code ?? ""), String(req.body?.email ?? ""));
    } catch (err) {
      throw fail(err);
    }
    return org.status();
  });

  app.post<{ Body: { token?: string; displayName?: string } }>("/api/org/verify", async (req) => {
    try {
      return await org.verify(String(req.body?.token ?? ""), String(req.body?.displayName ?? ""));
    } catch (err) {
      throw fail(err);
    }
  });

  app.post("/api/org/cancel", async () => {
    org.cancel();
    return org.status();
  });

  app.post("/api/org/sync", async () => {
    await org.heartbeat();
    return org.status();
  });

  app.post("/api/org/disconnect", async () => {
    await org.disconnect();
    return org.status();
  });
}
