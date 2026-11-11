import { type ReactNode, useEffect, useRef, useState } from "react";
import { Check, CircleCheck, X } from "lucide-react";
import { api } from "../api";

type Kind = "bug" | "idea";

/** Ô tích tự vẽ (không dùng checkbox gốc của trình duyệt). */
function Tick({ on, onChange, children }: { on: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} className="fb-tick" onClick={() => onChange(!on)}>
      <span className={on ? "grp-check on" : "grp-check"}>{on && <Check aria-hidden />}</span>
      <span className="fb-tick-text">{children}</span>
    </button>
  );
}

function browserName(ua: string) {
  if (/Edg\//.test(ua)) return "Edge";
  if (/Chrome\//.test(ua)) return "Chrome";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Safari\//.test(ua)) return "Safari";
  return "Trình duyệt khác";
}
const OS: Record<string, string> = { win32: "Windows", darwin: "macOS", linux: "Linux" };

/** Chụp phần app đang hiện (không có hộp báo lỗi), thu nhỏ để gửi nhẹ. */
async function captureScreen(): Promise<string | null> {
  try {
    const { toJpeg } = await import("html-to-image");
    const node = document.querySelector<HTMLElement>(".app") ?? document.body;
    const ratio = Math.min(1, 1600 / Math.max(1, node.clientWidth));
    return await toJpeg(node, {
      quality: 0.75,
      pixelRatio: ratio,
      backgroundColor: getComputedStyle(document.body).backgroundColor,
      filter: (el) => !(el instanceof HTMLElement && el.dataset.noCapture !== undefined),
    });
  } catch {
    return null;
  }
}

export function FeedbackDialog({ onClose, version, page }: { onClose: () => void; version: string; page: string }) {
  const [kind, setKind] = useState<Kind>("bug");
  const [message, setMessage] = useState("");
  const [contact, setContact] = useState("");
  const [shot, setShot] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(true);
  const [withShot, setWithShot] = useState(true);
  const [withInfo, setWithInfo] = useState(true);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [platform, setPlatform] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    captureScreen().then((s) => {
      setShot(s);
      setCapturing(false);
      if (!s) setWithShot(false);
    });
    api<{ enabled: boolean }>("/api/feedback/config")
      .then((r) => setEnabled(r.enabled))
      .catch(() => setEnabled(false));
    api<{ platform?: string }>("/api/status")
      .then((r) => setPlatform(r.platform ?? ""))
      .catch(() => undefined);
    textRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const send = async () => {
    setBusy(true);
    setError("");
    try {
      await api("/api/feedback", {
        body: {
          kind,
          message,
          contact,
          includeInfo: withInfo,
          page,
          userAgent: navigator.userAgent,
          screenshot: withShot && shot ? shot : undefined,
        },
      });
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const info = `Trợ lý CDN v${version} · ${OS[platform] ?? "Máy chủ"} · ${browserName(navigator.userAgent)} · trang ${page}`;

  return (
    <div className="modal" onClick={onClose} data-no-capture>
      <div className="modal-body fb" role="dialog" aria-label="Báo lỗi, góp ý" onClick={(e) => e.stopPropagation()}>
        <div className="fb-head">
          <div className="grow">
            <div className="fb-title">Báo lỗi, góp ý</div>
            <p className="muted small">Gửi thẳng tới đội làm Trợ lý CDN. Bạn xem trước mọi thứ gửi kèm.</p>
          </div>
          <button type="button" className="icon-only" aria-label="Đóng" onClick={onClose}>
            <X aria-hidden />
          </button>
        </div>

        {sent ? (
          <div className="fb-done">
            <span className="fb-done-ic">
              <CircleCheck aria-hidden />
            </span>
            <div className="t">Đã gửi, cảm ơn bạn!</div>
            <p className="muted small">{contact ? "Đội hỗ trợ sẽ liên hệ lại qua số bạn để lại nếu cần hỏi thêm." : "Đội hỗ trợ sẽ xem và sửa trong bản cập nhật tới."}</p>
            <button type="button" className="primary" onClick={onClose}>
              Đóng
            </button>
          </div>
        ) : (
          <>
            <div className="fb-body">
              <div className="grp-seg" role="tablist">
                {(
                  [
                    ["bug", "Báo lỗi"],
                    ["idea", "Góp ý"],
                  ] as [Kind, string][]
                ).map(([k, l]) => (
                  <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)}>
                    {l}
                  </button>
                ))}
              </div>
              <label className="fb-field">
                <span>{kind === "bug" ? "Chuyện gì xảy ra?" : "Bạn muốn app thêm hay đổi gì?"}</span>
                <textarea
                  ref={textRef}
                  rows={4}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder={kind === "bug" ? "VD: Bấm Gửi nháp thì báo lỗi, tin không tới khách." : "VD: Muốn lọc hộp thư theo nhãn Zalo."}
                />
              </label>

              <div className="fb-attach">
                <Tick on={withShot && Boolean(shot)} onChange={(v) => shot && setWithShot(v)}>
                  <span>Kèm ảnh chụp màn hình</span>
                  <span className="muted small">{capturing ? "Đang chụp…" : shot ? "Ảnh có thể có tên, tin nhắn khách: xem trước bên dưới." : "Không chụp được màn hình này."}</span>
                </Tick>
                {shot && withShot && <img className="fb-shot" src={shot} alt="Ảnh chụp sẽ gửi kèm" />}
                <Tick on={withInfo} onChange={setWithInfo}>
                  <span>Kèm thông tin máy và bản app</span>
                  <span className="muted small">{info}</span>
                </Tick>
              </div>

              <label className="fb-field">
                <span>
                  Số điện thoại / Zalo để liên hệ lại <span className="muted">(không bắt buộc)</span>
                </span>
                <input value={contact} onChange={(e) => setContact(e.target.value)} inputMode="tel" placeholder="VD: 0912 345 678" />
              </label>
              {enabled === false && <div className="notice warn small">Bản này chưa đặt nơi nhận báo lỗi (trường feedbackUrl trong package.json).</div>}
              {error && <div className="notice bad small">{error}</div>}
            </div>
            <div className="fb-foot">
              <button type="button" className="ghost" onClick={onClose}>
                Huỷ
              </button>
              <button type="button" className="primary" disabled={busy || message.trim().length < 5 || enabled === false || capturing} onClick={send}>
                {busy ? "Đang gửi…" : "Gửi"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
