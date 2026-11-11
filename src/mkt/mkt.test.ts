import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDb } from "../server/db.js";
import { SecretBox } from "../server/secrets.js";
import { buildApp } from "../server/app.js";
import { addDays, dayRange, vnDay } from "./dates.js";
import { fbPull, fbResolveToken } from "./connectors/facebook.js";
import { MktStore } from "./store.js";
import { MktRunner } from "./runner.js";
import { summarize } from "./summary.js";

const PAGE = "111";

/** Graph API giả: một trang, 2 bài trong khoảng, 1 bài cũ có bình luận mới; bình luận của trang phải bị bỏ. */
function fakeGraph(opts: { tokenError?: boolean } = {}) {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (opts.tokenError) return json({ error: { message: "Error validating access token", code: 190 } }, 400);
    const p = url.pathname.replace("/v26.0/", "");
    if (p === "me/accounts") {
      return (url.searchParams.get("access_token") ?? "").startsWith("user-token")
        ? json({ data: [{ id: PAGE, name: "Coach Duy Nguyễn", access_token: "page-token" }, { id: "222", name: "Trang phụ", access_token: "t2" }] })
        : json({ error: { message: "page token", code: 100 } }, 400);
    }
    if (p === "me") return json({ id: PAGE, name: "Coach Duy Nguyễn" });
    if (p === PAGE) return json({ name: "Coach Duy Nguyễn", followers_count: 15230 });
    if (p === `${PAGE}/insights`) {
      // end_time của Meta: nhãn ngày = 10 ký tự đầu.
      const vals = (base: number) => [
        { end_time: "2026-11-09T08:00:00+0000", value: base },
        { end_time: "2026-11-10T08:00:00+0000", value: base + 1 },
      ];
      return json({ data: [{ name: "page_media_view", values: vals(1000) }, { name: "page_post_engagements", values: vals(50) }, { name: "page_daily_follows", values: vals(3) }] });
    }
    if (p === `${PAGE}/posts`) {
      return json({
        data: [
          { id: "p1", created_time: "2026-11-09T18:30:00+0000", message: "Bài mới\nDòng hai", permalink_url: "https://fb/p1", comments: { summary: { total_count: 2 } }, reactions: { summary: { total_count: 9 } } },
          { id: "p2", created_time: "2026-11-08T03:00:00+0000", message: "", comments: { summary: { total_count: 0 } } },
          { id: "old", created_time: "2026-10-20T03:00:00+0000", message: "Bài cũ", comments: { summary: { total_count: 1 } } },
        ],
      });
    }
    if (p.endsWith("/insights")) return json({ data: [{ values: [{ value: p.startsWith("p1") ? 777 : 12 }] }] });
    if (p === "p1/comments")
      return json({ data: [{ created_time: "2026-11-09T18:40:00+0000", from: { id: "khach" } }, { created_time: "2026-11-09T19:00:00+0000", from: { id: PAGE } }] });
    if (p === "old/comments") return json({ data: [{ created_time: "2026-11-08T01:00:00+0000", from: { id: "khach2" } }] });
    return json({ error: { message: `không có ${p}`, code: 100 } }, 404);
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("ngày VN", () => {
  it("đổi mốc giờ sang ngày VN và dải ngày", () => {
    expect(vnDay(Date.parse("2026-11-09T18:30:00Z"))).toBe("2026-11-10");
    expect(vnDay(Date.parse("2026-11-09T16:59:00Z"))).toBe("2026-11-09");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(dayRange("2026-11-08", "2026-11-10")).toEqual(["2026-11-08", "2026-11-09", "2026-11-10"]);
  });
});

describe("Facebook", () => {
  it("lấy số: nhãn ngày Meta, bình luận theo giờ VN bỏ của trang, bài theo ngày đăng", async () => {
    const { f } = fakeGraph();
    const r = await fbPull(f, { id: PAGE, token: "page-token" }, "2026-11-07", "2026-11-10");
    expect(r.daily.views).toEqual([["2026-11-09", 1000], ["2026-11-10", 1001]]);
    expect(r.dataUntil).toBe("2026-11-10");
    const comments = Object.fromEntries(r.daily.comments!);
    expect(comments["2026-11-10"]).toBe(1); // 18:40 UTC ngày 9 = 01:40 ngày 10 giờ VN; bình luận của trang bị bỏ
    expect(comments["2026-11-08"]).toBe(1); // bình luận mới trên bài cũ vẫn đếm
    expect(comments["2026-11-07"]).toBe(0); // ngày đã quét mà không có = 0, không phải trống
    expect(Object.fromEntries(r.daily.posts!)).toMatchObject({ "2026-11-10": 1, "2026-11-08": 1, "2026-11-09": 0 });
    expect(r.posts.find((p) => p.postId === "p1")).toMatchObject({ day: "2026-11-10", title: "Bài mới", views: 777, comments: 2 });
    expect(r.posts.some((p) => p.postId === "old")).toBe(false); // bài cũ chỉ để quét bình luận
    expect(r.daily.followers).toEqual([["2026-11-10", 15230]]);
  });

  it("token dán tay: token người dùng ra danh sách trang, token trang ra đúng trang", async () => {
    const { f } = fakeGraph();
    expect((await fbResolveToken(f, "user-token")).map((p) => p.id)).toEqual([PAGE, "222"]);
    expect(await fbResolveToken(f, "page-token")).toEqual([{ id: PAGE, name: "Coach Duy Nguyễn", token: "page-token" }]);
  });
});

describe("MktRunner + tổng hợp", () => {
  const setup = (f: typeof fetch) => {
    const db = openDb(":memory:");
    const store = new MktStore(db, new SecretBox(crypto.randomBytes(32)));
    const notes: string[] = [];
    const runner = new MktRunner(store, { fetch: f, notify: (t) => notes.push(t), now: () => Date.parse("2026-11-10T05:00:00Z") });
    store.save("facebook", { status: "ok", secret: { pageId: PAGE, pageToken: "page-token" }, label: "Coach Duy Nguyễn" });
    return { store, runner, notes };
  };

  it("lần đầu lấy lùi 120 ngày, ghi số, tổng hợp kỳ và kỳ trước", async () => {
    const { f, calls } = fakeGraph();
    const { store, runner } = setup(f);
    await runner.pull("facebook");
    expect(calls.find((c) => c.includes("/insights?metric=page_media_view"))).toContain("since=2026-07-13");
    const s = summarize(store, "2026-11-09", "2026-11-10");
    const fb = s.channels.find((c) => c.kind === "facebook")!;
    expect(fb.totals.views).toBe(2001);
    expect(fb.prev.views).toBeNull(); // kỳ trước chưa có số Meta → trống, không phải 0
    expect(fb.prev.comments).toBe(1); // 07–08/11: một bình luận ngày 08
    expect(fb.followers).toBe(15230);
    expect(store.connection("facebook")).toMatchObject({ status: "ok", dataUntil: "2026-11-10" });
    expect(store.topPosts({ from: "2026-11-01", to: "2026-11-10" })[0]).toMatchObject({ postId: "p1", views: 777 });
  });

  it("token hết hạn: báo lỗi nối lại, ghi chuông một lần", async () => {
    const { f } = fakeGraph({ tokenError: true });
    const { store, runner, notes } = setup(f);
    await expect(runner.pull("facebook")).rejects.toThrow();
    await expect(runner.pull("facebook")).rejects.toThrow();
    expect(store.connection("facebook")).toMatchObject({ status: "error" });
    expect(store.connection("facebook").error).toMatch(/Nối lại/);
    expect(notes).toHaveLength(1);
  });

  it("khoá được mã hoá trong DB", () => {
    const db = openDb(":memory:");
    const store = new MktStore(db, new SecretBox(crypto.randomBytes(32)));
    store.save("facebook", { secret: { pageToken: "bi-mat-123" } });
    const raw = db.prepare("SELECT secret FROM mkt_connections").get() as { secret: string };
    expect(raw.secret).not.toContain("bi-mat-123");
    expect(store.secret<{ pageToken: string }>("facebook")?.pageToken).toBe("bi-mat-123");
  });
});

describe("route MKT", () => {
  it("tắt sẵn: không có route MKT, /api/status báo tắt, callback cũng phải đăng nhập", async () => {
    const app = await buildApp({ db: openDb(":memory:"), box: new SecretBox(crypto.randomBytes(32)) });
    expect((await app.inject({ url: "/api/status" })).json().features).toEqual({ mkt: false });
    expect((await app.inject({ url: "/api/mkt/oauth/facebook/callback?code=x&state=y" })).statusCode).toBe(401);
    const setup = await app.inject({ method: "POST", url: "/api/setup", payload: { username: "quantri", password: "matkhau123" } });
    const cookie = String(setup.headers["set-cookie"]).split(";")[0]!;
    expect((await app.inject({ url: "/api/mkt/connections", headers: { cookie } })).statusCode).toBe(404);
    await app.close();
  });

  it("callback Facebook không cần cookie nhưng phải có state hợp lệ; token dán tay nhiều trang thì chờ chọn", async () => {
    const { f } = fakeGraph();
    const app = await buildApp({ db: openDb(":memory:"), box: new SecretBox(crypto.randomBytes(32)), mktFetch: f, mkt: true });
    const cb = await app.inject({ url: "/api/mkt/oauth/facebook/callback?code=x&state=gia" });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toContain("fb=loi");
    // Các route khác vẫn cần đăng nhập.
    expect((await app.inject({ url: "/api/mkt/connections" })).statusCode).toBe(401);
    const setup = await app.inject({ method: "POST", url: "/api/setup", payload: { username: "quantri", password: "matkhau123" } });
    const cookie = String(setup.headers["set-cookie"]).split(";")[0]!;
    const short = await app.inject({ method: "POST", url: "/api/mkt/facebook/token", payload: { token: "ngan" }, headers: { cookie } });
    expect(short.statusCode).toBe(400);
    const r = await app.inject({ method: "POST", url: "/api/mkt/facebook/token", payload: { token: `user-token-${"x".repeat(20)}` }, headers: { cookie } });
    expect(r.json()).toMatchObject({ pages: [{ id: PAGE }, { id: "222" }] });
    const chosen = await app.inject({ method: "POST", url: "/api/mkt/facebook/choose", payload: { pending: r.json().pending, pageId: PAGE }, headers: { cookie } });
    expect(chosen.json()).toEqual({ connected: "Coach Duy Nguyễn" });
    const list = await app.inject({ url: "/api/mkt/connections", headers: { cookie } });
    expect(list.json().connections.find((c: { kind: string }) => c.kind === "facebook")).toMatchObject({ available: true, status: "ok", label: "Coach Duy Nguyễn" });
    await app.close();
  });
});

describe("YouTube", () => {
  it("lấy số: ngày chưa báo để trống, đăng ký ròng, chỉ đếm video công khai theo giờ VN", async () => {
    const { ytPull, parseClientJson } = await import("./connectors/youtube.js");
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (url.hostname === "oauth2.googleapis.com") {
        const body = new URLSearchParams(String(init?.body));
        return body.get("refresh_token") === "rt" ? json({ access_token: "at" }) : json({ error: "invalid_grant" }, 400);
      }
      if (url.pathname.endsWith("/channels")) return json({ items: [{ id: "UC1", snippet: { title: "Coach Duy Nguyen" }, contentDetails: { relatedPlaylists: { uploads: "UU1" } }, statistics: { subscriberCount: "3200" } }] });
      if (url.pathname.endsWith("/reports")) return json({ rows: [["2026-11-07", 2044, 3, 40, 10, 2, 900], ["2026-11-08", 2628, 2, 51, 6, 1, 1100]] });
      if (url.pathname.endsWith("/playlistItems"))
        return json({
          items: [
            { contentDetails: { videoId: "v1", videoPublishedAt: "2026-11-08T18:00:00Z" }, status: { privacyStatus: "public" } },
            { contentDetails: { videoId: "v2", videoPublishedAt: "2026-11-08T03:00:00Z" }, status: { privacyStatus: "unlisted" } },
            { contentDetails: { videoId: "v0", videoPublishedAt: "2026-10-01T03:00:00Z" }, status: { privacyStatus: "public" } },
          ],
        });
      if (url.pathname.endsWith("/videos")) return json({ items: [{ id: "v1", snippet: { title: "Vì sao đội sale…" }, statistics: { viewCount: "6210", commentCount: "38" } }] });
      return json({ error: { message: "?" } }, 404);
    }) as unknown as typeof fetch;
    const r = await ytPull(f, { clientId: "c", clientSecret: "s" }, "rt", "2026-11-06", "2026-11-10");
    expect(Object.fromEntries(r.daily.views!)).toEqual({ "2026-11-06": null, "2026-11-07": 2044, "2026-11-08": 2628, "2026-11-09": null, "2026-11-10": null });
    expect(Object.fromEntries(r.daily.follows!)["2026-11-07"]).toBe(8);
    expect(Object.fromEntries(r.daily.posts!)).toMatchObject({ "2026-11-09": 1, "2026-11-08": 0 }); // 18:00 UTC ngày 8 = ngày 9 giờ VN; video không công khai bỏ
    expect(r.posts).toEqual([expect.objectContaining({ postId: "v1", day: "2026-11-09", views: 6210, comments: 38 })]);
    expect(r).toMatchObject({ dataUntil: "2026-11-08", followers: 3200, channelTitle: "Coach Duy Nguyen" });
    await expect(ytPull(f, { clientId: "c", clientSecret: "s" }, "het-han", "2026-11-06", "2026-11-10")).rejects.toMatchObject({ needsReconnect: true });
    expect(parseClientJson(JSON.stringify({ installed: { client_id: "id", client_secret: "sec" } }))).toEqual({ clientId: "id", clientSecret: "sec" });
    expect(() => parseClientJson("không phải json")).toThrow(/JSON/);
  });

  it("gọt token dán tay", async () => {
    const { cleanToken } = await import("../server/routes/mkt.js");
    expect(cleanToken('META_PAGE_ACCESS_TOKEN="EAAGabc123"\n')).toBe("EAAGabc123");
    expect(cleanToken("  Bearer EAAG abc  ")).toBe("EAAGabc");
  });
});

describe("Pancake CRM", () => {
  it("đếm người theo ngày đầu, phân nguồn, workshop riêng, tổng khử trùng hai bảng, founder", async () => {
    const { leadDaily, DEFAULT_RULES, normPhone, dayOf } = await import("./connectors/pancake.js");
    expect(normPhone("+84 912 345 678")).toBe("0912345678");
    expect(normPhone("912345678")).toBe("0912345678");
    expect(dayOf({ CreatedOn: "2026-11-01T18:30:00" })).toBe("2026-11-02"); // UTC → ngày VN
    const contact = [
      { CreatedOn: "2026-11-01T02:00:00", Phone: "0912345678", nguon_khach_hang: "Facebook-Coach Duy Nguyễn", chuc_danh: "CEO/Chủ doanh nghiệp" },
      { CreatedOn: "2026-11-03T02:00:00", Phone: "84912345678", nguon_khach_hang: "Web lead magnet" }, // trùng người: vẫn tính ngày 01, nguồn lần đầu
      { CreatedOn: "2026-11-01T03:00:00", Phone: "0900000001", nguon_khach_hang: "Cộng đồng GT", ad_id: "123" }, // có mã quảng cáo → other
      { CreatedOn: "2026-11-02T03:00:00", nguon_khach_hang: "nguồn lạ" }, // không số điện thoại, nguồn lạ → other
    ];
    const workshop = [
      { CreatedOn: "2026-11-02T04:00:00", Phone: "0912345678" }, // đã có ở Contact: workshop vẫn đếm, total không đếm lại
      { CreatedOn: "2026-11-02T05:00:00", Phone: "0988888888", chuc_danh: "Kinh doanh tự do" },
    ];
    const d = leadDaily(contact, workshop, DEFAULT_RULES);
    expect(d.get("2026-11-01")).toEqual({ organic: 1, other: 1, total: 2, founder: 1 });
    expect(d.get("2026-11-02")).toEqual({ workshop: 2, other: 1, total: 2, founder: 1 });
    expect(d.get("2026-11-03")).toBeUndefined();
  });
});
