import { useState } from "react";
import { Download, Plug } from "lucide-react";
import { DailyTable, type Kind, NAMES, type Post, RangeBar, TopPosts, csvUrl, useConnections, useMktData, useRange } from "./common";

const TABS: Kind[] = ["facebook", "youtube", "tiktok", "meta_ads", "pancake"];
const TAB_LABEL: Partial<Record<Kind, string>> = { pancake: "Lead" };

/** Màn Kênh: tab từng kênh, bảng số từng ngày (mới nhất trước) và top bài. */
export function ChannelsPage({ onGoConnect }: { onGoConnect: () => void }) {
  const range = useRange();
  const conns = useConnections();
  const [kind, setKind] = useState<Kind>("facebook");
  const [sort, setSort] = useState<"views" | "comments">("views");
  const posts = useMktData<{ posts: Post[] }>(kind === "pancake" ? null : `/api/mkt/posts?kind=${kind}&from=${range.from}&to=${range.to}&sort=${sort}&limit=10`);
  const conn = conns.data?.connections.find((c) => c.kind === kind);

  return (
    <div className="mkt-stack">
      <RangeBar range={range} />
      <div className="utabs mkt-fade" role="tablist">
        {TABS.map((k) => {
          const c = conns.data?.connections.find((x) => x.kind === k);
          return (
            <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)}>
              {TAB_LABEL[k] ?? NAMES[k]}
              {c && c.status === "off" && <span className="badge mkt-badge off">{c.available ? "Chưa nối" : "Sắp có"}</span>}
              {c?.status === "error" && <span className="badge mkt-badge bad">Lỗi</span>}
            </button>
          );
        })}
      </div>
      {!conn ? (
        <p className="muted small">Đang tải…</p>
      ) : conn.status === "off" ? (
        <div className="card grp-empty">
          <div className="t">{NAMES[kind]} chưa nối</div>
          <p>{conn.available ? "Nối kênh để xem số từng ngày và bài đăng hiệu quả nhất." : "Kênh này sắp có trong bản cập nhật tới."}</p>
          {conn.available && (
            <button type="button" className="primary" onClick={onGoConnect}>
              <Plug aria-hidden />
              Kết nối
            </button>
          )}
        </div>
      ) : (
        <div className={kind === "pancake" ? "mkt-detail single" : "mkt-detail"}>
          <div className="card mkt-daily">
            <div className="mkt-card-head">
              <h2 className="mkt-h2">Từng ngày{conn.label ? ` · ${conn.label}` : ""}</h2>
              {kind === "facebook" && <span className="muted small mkt-note">Lượt xem gồm cả từ quảng cáo</span>}
              <a className="btn-link-outline push" href={csvUrl(kind, range.from, range.to)}>
                <Download aria-hidden />
                Xuất CSV
              </a>
            </div>
            <DailyTable kind={kind} from={range.from} to={range.to} />
          </div>
          {kind !== "pancake" && <div className="card mkt-top">
            <div className="mkt-card-head">
              <h2 className="mkt-h2">Top bài</h2>
              <div className="grp-seg push" role="tablist">
                <button type="button" role="tab" aria-selected={sort === "views"} onClick={() => setSort("views")}>
                  Lượt xem
                </button>
                <button type="button" role="tab" aria-selected={sort === "comments"} onClick={() => setSort("comments")}>
                  Bình luận
                </button>
              </div>
            </div>
            <TopPosts posts={posts.data?.posts ?? []} />
          </div>}
        </div>
      )}
    </div>
  );
}
