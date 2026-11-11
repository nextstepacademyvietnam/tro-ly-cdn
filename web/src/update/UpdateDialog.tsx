import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpCircle, Check, CircleAlert, Download, LoaderCircle, RefreshCw, X } from "lucide-react";
import { api } from "../api";

export interface UpdateStatus {
  current: string;
  latest: string | null;
  notes: string;
  url: string;
  publishedAt: string;
  important: boolean;
  canSelfUpdate: boolean;
  checkedAt: number;
  checkEnabled: boolean;
  state: "idle" | "downloading" | "verifying" | "installing" | "backing_up" | "restarting" | "error";
  error: string;
  lastResult: { result: "ok" | "rolled_back"; from: string; to: string; at: number; error?: string } | null;
}

const STEPS: { key: UpdateStatus["state"]; label: string }[] = [
  { key: "downloading", label: "Tải bản mới" },
  { key: "verifying", label: "Kiểm tra gói cài" },
  { key: "installing", label: "Cài đặt" },
  { key: "backing_up", label: "Sao lưu dữ liệu" },
  { key: "restarting", label: "Khởi động lại" },
];
const busy = (s?: UpdateStatus | null) => !!s && s.state !== "idle" && s.state !== "error";

/** Trạng thái cập nhật: hỏi mỗi phút, đang cập nhật thì mỗi giây; lúc khởi động lại thì chờ bản mới lên rồi tải lại trang. */
export function useUpdate() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [restarting, setRestarting] = useState(false);
  const load = useCallback(() => api<UpdateStatus>("/api/update").then(setStatus), []);
  useEffect(() => {
    load().catch(() => undefined);
    const t = setInterval(() => load().catch(() => undefined), busy(status) ? 1000 : 60_000);
    return () => clearInterval(t);
  }, [load, busy(status)]); // eslint-disable-line react-hooks/exhaustive-deps

  // App đã tắt để đổi bản: hỏi /api/status tới khi có số bản khác bản cũ (hoặc app quay về bản cũ).
  const waitingFrom = useRef<string | null>(null);
  useEffect(() => {
    if (status?.state !== "restarting" || waitingFrom.current) return;
    waitingFrom.current = status.current;
    setRestarting(true);
    let wentDown = false;
    const t = setInterval(async () => {
      try {
        const s = await api<{ version: string }>("/api/status");
        if (s.version !== waitingFrom.current || wentDown) location.reload();
      } catch {
        wentDown = true;
      }
    }, 1500);
    return () => clearInterval(t);
  }, [status?.state, status?.current]);

  return { status, setStatus, load, restarting };
}

/** Thanh báo dưới header: có bản mới, hoặc kết quả lần cập nhật trước. */
export function UpdateBanner({ status, onOpen, onChanged }: { status: UpdateStatus | null; onOpen: () => void; onChanged: () => void }) {
  const [hidden, setHidden] = useState<string | null>(null);
  if (!status) return null;
  const r = status.lastResult;
  if (r) {
    const ok = r.result === "ok";
    return (
      <div className={ok ? "update-bar ok" : "update-bar bad"} role="status">
        {ok ? <Check aria-hidden /> : <CircleAlert aria-hidden />}
        <span className="update-text">
          {ok ? (
            <>
              Đã cập nhật lên <b>v{r.to}</b>.
            </>
          ) : (
            <>
              Cập nhật lên v{r.to} không thành công, app đã quay về <b>v{r.from}</b>. {r.error}
            </>
          )}
        </span>
        <button type="button" className="icon-only" aria-label="Đóng" onClick={() => api("/api/update/dismiss-result", { method: "POST" }).then(onChanged)}>
          <X aria-hidden />
        </button>
      </div>
    );
  }
  if (!status.latest || (hidden === status.latest && !status.important && !busy(status))) return null;
  return (
    <div className="update-bar" role="status">
      <ArrowUpCircle aria-hidden />
      <span className="update-text">
        {busy(status) ? (
          <>Đang cập nhật lên <b>v{status.latest}</b>…</>
        ) : (
          <>
            Có bản mới <b>v{status.latest}</b>
            {status.important && " · có thay đổi quan trọng"}
          </>
        )}
      </span>
      <button type="button" className="link" onClick={onOpen}>
        Xem thay đổi
      </button>
      {!busy(status) && (
        <button type="button" className="primary small-btn" onClick={onOpen}>
          Cập nhật ngay
        </button>
      )}
      {!status.important && !busy(status) && (
        <button type="button" className="icon-only" aria-label="Ẩn tới lần mở app sau" title="Ẩn tới lần mở app sau" onClick={() => setHidden(status.latest)}>
          <X aria-hidden />
        </button>
      )}
    </div>
  );
}

/** Vẽ ghi chú thay đổi (markdown đơn giản: tiêu đề, gạch đầu dòng, chữ đậm) — không dùng innerHTML. */
function Notes({ md }: { md: string }) {
  const inline = (s: string): ReactNode[] => s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((p, i) => (p.startsWith("**") ? <b key={i}>{p.slice(2, -2)}</b> : p.startsWith("`") ? <code key={i}>{p.slice(1, -1)}</code> : p));
  const out: ReactNode[] = [];
  let list: ReactNode[] = [];
  const flush = () => {
    if (list.length) out.push(<ul key={`u${out.length}`}>{list}</ul>);
    list = [];
  };
  md.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t) return flush();
    const h = t.match(/^#{1,6}\s+(.*)$/);
    const li = t.match(/^[-*]\s+(.*)$/);
    if (h) {
      flush();
      out.push(<h4 key={i}>{inline(h[1]!)}</h4>);
    } else if (li) list.push(<li key={i}>{inline(li[1]!)}</li>);
    else {
      flush();
      out.push(<p key={i}>{inline(t)}</p>);
    }
  });
  flush();
  return <div className="notes-md">{out}</div>;
}

export function UpdateDialog({
  status,
  restarting,
  onClose,
  onStatus,
}: {
  status: UpdateStatus;
  restarting: boolean;
  onClose: () => void;
  onStatus: (s: UpdateStatus) => void;
}) {
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const running = busy(status) || restarting;
  const stepIndex = STEPS.findIndex((s) => s.key === status.state);

  const apply = async () => {
    setError("");
    try {
      onStatus(await api<UpdateStatus>("/api/update/apply", { method: "POST" }));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const check = async () => {
    setChecking(true);
    setError("");
    try {
      onStatus(await api<UpdateStatus>("/api/update/check", { method: "POST" }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="modal" onClick={() => !running && onClose()}>
      <div className="modal-body card update-dialog" role="dialog" aria-label="Cập nhật" onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <h2>{status.latest ? `Bản mới v${status.latest}` : "Phiên bản"}</h2>
          {!running && (
            <button type="button" className="icon-only" aria-label="Đóng" onClick={onClose}>
              <X aria-hidden />
            </button>
          )}
        </div>
        <p className="muted small">
          Đang dùng v{status.current}
          {status.publishedAt && status.latest ? ` · bản mới phát hành ${new Date(status.publishedAt).toLocaleDateString("vi-VN")}` : ""}
        </p>

        {!status.latest && (
          <div className="stack-sm">
            <p>{status.checkEnabled ? "Bạn đang dùng bản mới nhất." : "Bản này đã tắt kiểm tra cập nhật."}</p>
            {status.checkedAt > 0 && <p className="muted small">Kiểm tra lần cuối: {new Date(status.checkedAt).toLocaleString("vi-VN")}</p>}
            {status.checkEnabled && (
              <div>
                <button type="button" onClick={check} disabled={checking}>
                  <RefreshCw aria-hidden />
                  {checking ? "Đang kiểm tra…" : "Kiểm tra bản mới"}
                </button>
              </div>
            )}
          </div>
        )}

        {status.latest && (
          <>
            <div className="form-scroll update-notes">{status.notes ? <Notes md={status.notes} /> : <p className="muted">Bản phát hành chưa có ghi chú.</p>}</div>
            {running ? (
              <ol className="update-steps">
                {STEPS.map((s, i) => (
                  <li key={s.key} className={i < stepIndex || restarting ? "done" : i === stepIndex ? "now" : ""}>
                    {i < stepIndex || (restarting && i < STEPS.length - 1) ? <Check aria-hidden /> : i === stepIndex || (restarting && i === STEPS.length - 1) ? <LoaderCircle className="spin" aria-hidden /> : <span className="step-dot" />}
                    {s.label}
                  </li>
                ))}
              </ol>
            ) : status.canSelfUpdate ? (
              <>
                <p className="small muted">Dữ liệu được sao lưu trước khi cập nhật. Nếu bản mới không chạy được, app tự quay về bản đang dùng. Trợ lý ngưng trả lời khoảng một phút.</p>
                {status.state === "error" && <div className="notice bad small">{status.error}</div>}
                <div className="row">
                  <button type="button" className="primary" onClick={apply}>
                    <Download aria-hidden />
                    {status.state === "error" ? "Thử lại" : "Cập nhật ngay"}
                  </button>
                  {status.url && (
                    <a className="small" href={status.url} target="_blank" rel="noreferrer">
                      Xem trên GitHub
                    </a>
                  )}
                </div>
              </>
            ) : (
              <div className="stack-sm">
                <p className="small">Bản này chạy từ mã nguồn nên không tự cập nhật được. Mở cửa sổ lệnh trong thư mục app rồi chạy:</p>
                <pre className="doc-text update-cmd">git pull{"\n"}npm install{"\n"}npm run build</pre>
                <p className="small muted">Sau đó tắt app và bật lại.</p>
              </div>
            )}
          </>
        )}
        {error && <div className="notice bad small">{error}</div>}
      </div>
    </div>
  );
}
