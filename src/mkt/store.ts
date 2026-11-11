import type { DB } from "../server/db.js";
import type { SecretBox } from "../server/secrets.js";

/** Các nền tảng của mục MKT. Mỗi loại một kết nối cho cả app (không theo tài khoản Zalo). */
export const MKT_KINDS = ["facebook", "youtube", "tiktok", "meta_ads", "pancake", "gsheet"] as const;
export type MktKind = (typeof MKT_KINDS)[number];
export const isMktKind = (s: unknown): s is MktKind => typeof s === "string" && (MKT_KINDS as readonly string[]).includes(s);

export interface Connection {
  kind: MktKind;
  label: string;
  status: "off" | "ok" | "error";
  error: string;
  meta: Record<string, unknown>;
  hasSecret: boolean;
  connectedAt: number;
  pulledAt: number;
  dataUntil: string;
}

export interface PostRow {
  kind: MktKind;
  postId: string;
  day: string;
  title: string;
  url: string;
  views: number | null;
  comments: number | null;
  reactions: number | null;
}

type ConnPatch = Partial<Pick<Connection, "label" | "status" | "error" | "meta" | "connectedAt" | "pulledAt" | "dataUntil">> & {
  /** Bí mật (token, khoá app) — lưu mã hoá. `null` để xoá. */
  secret?: Record<string, unknown> | null;
};

export class MktStore {
  constructor(
    private readonly db: DB,
    private readonly box: SecretBox,
  ) {}

  connection(kind: MktKind): Connection {
    const r = this.db.prepare("SELECT * FROM mkt_connections WHERE kind = ?").get(kind) as Record<string, unknown> | undefined;
    if (!r) return { kind, label: "", status: "off", error: "", meta: {}, hasSecret: false, connectedAt: 0, pulledAt: 0, dataUntil: "" };
    return {
      kind,
      label: String(r.label),
      status: r.status as Connection["status"],
      error: String(r.error),
      meta: JSON.parse(String(r.meta || "{}")) as Record<string, unknown>,
      hasSecret: Boolean(r.secret),
      connectedAt: Number(r.connected_at),
      pulledAt: Number(r.pulled_at),
      dataUntil: String(r.data_until),
    };
  }

  connections(): Connection[] {
    return MKT_KINDS.map((k) => this.connection(k));
  }

  secret<T = Record<string, unknown>>(kind: MktKind): T | null {
    const r = this.db.prepare("SELECT secret FROM mkt_connections WHERE kind = ?").get(kind) as { secret: string } | undefined;
    return r?.secret ? (JSON.parse(this.box.decrypt(r.secret)) as T) : null;
  }

  save(kind: MktKind, patch: ConnPatch): Connection {
    const cur = this.connection(kind);
    const curSecret = this.db.prepare("SELECT secret FROM mkt_connections WHERE kind = ?").get(kind) as { secret: string } | undefined;
    const next = { ...cur, ...patch };
    const secret = patch.secret === undefined ? (curSecret?.secret ?? "") : patch.secret === null ? "" : this.box.encrypt(JSON.stringify(patch.secret));
    this.db
      .prepare(
        `INSERT INTO mkt_connections (kind, label, status, error, secret, meta, connected_at, pulled_at, data_until)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(kind) DO UPDATE SET label = excluded.label, status = excluded.status, error = excluded.error, secret = excluded.secret,
           meta = excluded.meta, connected_at = excluded.connected_at, pulled_at = excluded.pulled_at, data_until = excluded.data_until`,
      )
      .run(kind, next.label, next.status, next.error.slice(0, 500), secret, JSON.stringify(next.meta ?? {}), next.connectedAt, next.pulledAt, next.dataUntil);
    return this.connection(kind);
  }

  /** Ngắt kết nối: xoá khoá, giữ số đã lấy (nối lại thì dùng tiếp). */
  disconnect(kind: MktKind) {
    this.db.prepare("DELETE FROM mkt_connections WHERE kind = ?").run(kind);
  }

  /** Ghi số theo ngày; giá trị null thì xoá ô đó (ngày chưa có số để trống, không ghi 0). */
  putDaily(kind: MktKind, metric: string, rows: [day: string, value: number | null][], now = Date.now()) {
    const up = this.db.prepare(
      "INSERT INTO mkt_daily (kind, metric, day, value, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(kind, metric, day) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    );
    const del = this.db.prepare("DELETE FROM mkt_daily WHERE kind = ? AND metric = ? AND day = ?");
    this.db.exec("BEGIN");
    try {
      for (const [day, value] of rows) {
        if (value === null || !Number.isFinite(value)) del.run(kind, metric, day);
        else up.run(kind, metric, day, value, now);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  daily(from: string, to: string, kinds?: MktKind[]): { kind: MktKind; metric: string; day: string; value: number }[] {
    const rows = this.db
      .prepare("SELECT kind, metric, day, value FROM mkt_daily WHERE day >= ? AND day <= ? ORDER BY day")
      .all(from, to) as { kind: MktKind; metric: string; day: string; value: number }[];
    return kinds ? rows.filter((r) => kinds.includes(r.kind)) : rows;
  }

  upsertPosts(posts: PostRow[], now = Date.now()) {
    const st = this.db.prepare(
      `INSERT INTO mkt_posts (kind, post_id, day, title, url, views, comments, reactions, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(kind, post_id) DO UPDATE SET day = excluded.day, title = excluded.title, url = excluded.url,
         views = excluded.views, comments = excluded.comments, reactions = excluded.reactions, updated_at = excluded.updated_at`,
    );
    this.db.exec("BEGIN");
    try {
      for (const p of posts) st.run(p.kind, p.postId, p.day, p.title.slice(0, 500), p.url, p.views, p.comments, p.reactions, now);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  topPosts(opts: { from: string; to: string; kind?: MktKind; sort?: "views" | "comments"; limit?: number }): PostRow[] {
    const col = opts.sort === "comments" ? "comments" : "views";
    const rows = this.db
      .prepare(
        `SELECT * FROM mkt_posts WHERE day >= ? AND day <= ? ${opts.kind ? "AND kind = ?" : ""}
         ORDER BY ${col} IS NULL, ${col} DESC, day DESC LIMIT ?`,
      )
      .all(...([opts.from, opts.to, ...(opts.kind ? [opts.kind] : []), opts.limit ?? 10] as string[])) as Record<string, unknown>[];
    return rows.map((r) => ({
      kind: r.kind as MktKind,
      postId: String(r.post_id),
      day: String(r.day),
      title: String(r.title),
      url: String(r.url),
      views: r.views === null ? null : Number(r.views),
      comments: r.comments === null ? null : Number(r.comments),
      reactions: r.reactions === null ? null : Number(r.reactions),
    }));
  }

  addRun(kind: MktKind, ok: boolean, message: string, at = Date.now()) {
    this.db.prepare("INSERT INTO mkt_runs (kind, ok, message, at) VALUES (?, ?, ?, ?)").run(kind, ok ? 1 : 0, message.slice(0, 1000), at);
    this.db.prepare("DELETE FROM mkt_runs WHERE id NOT IN (SELECT id FROM mkt_runs ORDER BY id DESC LIMIT 500)").run();
  }

  runs(kind?: MktKind, limit = 20): { kind: MktKind; ok: boolean; message: string; at: number }[] {
    const rows = (kind
      ? this.db.prepare("SELECT * FROM mkt_runs WHERE kind = ? ORDER BY id DESC LIMIT ?").all(kind, limit)
      : this.db.prepare("SELECT * FROM mkt_runs ORDER BY id DESC LIMIT ?").all(limit)) as Record<string, unknown>[];
    return rows.map((r) => ({ kind: r.kind as MktKind, ok: Boolean(r.ok), message: String(r.message), at: Number(r.at) }));
  }
}
