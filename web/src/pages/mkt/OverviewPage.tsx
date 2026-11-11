import { useState } from "react";
import { ChartLine, CircleAlert, Plug, UserPlus, WifiOff } from "lucide-react";
import { type ChannelSummary, ChannelCard, DetailDrawer, type Kind, KpiCard, LeadBars, RangeBar, type Summary, compact, dm, fmt, pct, useConnections, useMktData, useRange } from "./common";

const CARD_KINDS: Kind[] = ["facebook", "youtube", "meta_ads", "tiktok"];
const CONTENT: Kind[] = ["facebook", "youtube", "tiktok"];

/** Tổng của một chỉ số qua các kênh nội dung; null khi chưa kênh nào có số. */
function across(chs: ChannelSummary[], metric: string, key: "totals" | "prev") {
  const vals = chs.filter((c) => CONTENT.includes(c.kind)).map((c) => c[key][metric] ?? null);
  return vals.some((v) => v !== null) ? vals.reduce<number>((s, v) => s + (v ?? 0), 0) : null;
}

export function OverviewPage({ onGoConnect }: { onGoConnect: () => void }) {
  const range = useRange();
  const conns = useConnections();
  const { data, error, load } = useMktData<Summary>(`/api/mkt/summary?from=${range.from}&to=${range.to}`);
  const [detail, setDetail] = useState<Kind | null>(null);

  if (error && !data) {
    return (
      <div className="card grp-empty">
        <span className="ic bad">
          <WifiOff aria-hidden />
        </span>
        <div className="t">Không tải được số liệu</div>
        <p>Mất kết nối tới máy chạy trợ lý.</p>
        <button type="button" onClick={load}>
          Thử lại
        </button>
      </div>
    );
  }
  if (!data || !conns.data) return <OverviewSkeleton />;

  const list = conns.data.connections;
  const anyConnected = list.some((c) => c.status !== "off");
  if (!anyConnected) {
    return (
      <div className="card grp-empty">
        <span className="ic">
          <ChartLine aria-hidden />
        </span>
        <div className="t">Chưa nối kênh nào</div>
        <p>Nối Fanpage, YouTube, TikTok để app tự lấy số mỗi sáng và đổ vào Google Sheet của bạn.</p>
        <button type="button" className="primary" onClick={onGoConnect}>
          <Plug aria-hidden />
          Nối kênh đầu tiên
        </button>
      </div>
    );
  }

  const chs = data.channels;
  const ch = (k: Kind) => chs.find((c) => c.kind === k);
  const errors = list.filter((c) => c.status === "error");
  const lagging = chs.filter((c) => c.status !== "off" && c.dataUntil && c.dataUntil < data.to);
  const ads = ch("meta_ads");
  const leads = ch("pancake");
  const views = across(chs, "views", "totals");
  const follows = across(chs, "follows", "totals");
  const contentNames = chs.filter((c) => CONTENT.includes(c.kind) && c.status !== "off").map((c) => list.find((x) => x.kind === c.kind)?.name);

  return (
    <div className="mkt-stack">
      <RangeBar
        range={range}
        note={lagging.length ? `Số tới ${dm(data.to)} · ${lagging.map((c) => `${list.find((x) => x.kind === c.kind)?.name} tới ${dm(c.dataUntil)}`).join(", ")}` : undefined}
      />
      {errors.map((c) => (
        <div key={c.kind} className="mkt-err-bar" role="alert">
          <CircleAlert aria-hidden />
          <span>
            <b>{c.name}:</b> {c.error}
          </span>
          <button type="button" className="ghost small-btn" onClick={onGoConnect}>
            Nối lại
          </button>
        </div>
      ))}
      <div className="mkt-kpis">
        <KpiCard label="Lượt xem" value={compact(views)} delta={pct(views, across(chs, "views", "prev"))} sub={contentNames.join(" + ") || "Chưa nối kênh nội dung"} />
        <KpiCard label="Bình luận" value={fmt(across(chs, "comments", "totals"))} delta={pct(across(chs, "comments", "totals"), across(chs, "comments", "prev"))} sub="trên bài của trang, kênh" />
        <KpiCard
          label="Bài đăng"
          value={fmt(across(chs, "posts", "totals"))}
          delta={pct(across(chs, "posts", "totals"), across(chs, "posts", "prev"))}
          sub={chs.filter((c) => CONTENT.includes(c.kind) && c.totals.posts !== null).map((c) => `${list.find((x) => x.kind === c.kind)?.name} ${fmt(c.totals.posts)}`).join(" · ") || "—"}
        />
        <KpiCard label="Theo dõi mới" value={follows === null ? "—" : `+${fmt(follows)}`} delta={pct(follows, across(chs, "follows", "prev"))} sub="người theo dõi, đăng ký" />
        <KpiCard
          label="Chi tiêu QC"
          value={ads && ads.status !== "off" && ads.totals.spend !== null ? `${compact(ads.totals.spend)} ₫` : "—"}
          delta={ads ? pct(ads.totals.spend, ads.prev.spend) : null}
          sub={ads && ads.status !== "off" ? (ads.dataUntil ? `tới ${dm(ads.dataUntil)}` : "") : "Chưa nối quảng cáo"}
        />
        <KpiCard
          label="Lead"
          value={leads && leads.status !== "off" ? fmt(leads.totals.total) : "—"}
          delta={leads ? pct(leads.totals.total, leads.prev.total) : null}
          sub={leads && leads.status !== "off" ? `${fmt(leads.totals.founder)} founder` : "Chưa nối Pancake CRM"}
        />
      </div>
      <div className="mkt-two">
        <div className="mkt-ch-grid">
          {CARD_KINDS.map((k) => {
            const conn = list.find((c) => c.kind === k)!;
            return <ChannelCard key={k} ch={ch(k)} conn={conn} onDetail={() => setDetail(k)} onConnect={onGoConnect} />;
          })}
        </div>
        <div className="card mkt-leads">
          <h2 className="mkt-h2">Lead theo nguồn</h2>
          {leads && leads.status !== "off" ? (
            <>
              {leads.status === "error" && <div className="mkt-err-box">{list.find((c) => c.kind === "pancake")?.error}</div>}
              <LeadBars ch={leads} />
            </>
          ) : (
            <div className="grp-empty mkt-leads-empty">
              <span className="ic">
                <UserPlus aria-hidden />
              </span>
              <p>Nối Pancake CRM để xem lead theo nguồn: organic, workshop, lead magnet…</p>
              <button type="button" className="primary" onClick={onGoConnect}>
                <Plug aria-hidden />
                Kết nối
              </button>
            </div>
          )}
        </div>
      </div>
      <DetailDrawer kind={detail} label={detail ? (ch(detail)?.label ?? "") : ""} from={data.from} to={data.to} onClose={() => setDetail(null)} />
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="mkt-stack" aria-busy="true">
      <span className="skel" style={{ height: 40, width: 320 }} />
      <div className="mkt-kpis">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="card mkt-kpi">
            <span className="skel" style={{ height: 12, width: 64 }} />
            <span className="skel" style={{ height: 28, width: 96 }} />
          </div>
        ))}
      </div>
      <div className="card" style={{ height: 240 }}>
        <span className="skel" style={{ height: "100%" }} />
      </div>
    </div>
  );
}
