import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { type Account, api } from "../api";

type State = "logged_out" | "waiting_qr" | "scanned" | "connecting" | "connected" | "reconnecting" | "error";
interface Status {
  state: State;
  qrImage?: string;
  scannedName?: string;
  ownId?: string;
  ownName?: string;
  error?: string;
  hasSession: boolean;
}

function usePolling(fn: () => void, ms: number) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    ref.current();
    const t = setInterval(() => ref.current(), ms);
    return () => clearInterval(t);
  }, [ms]);
}

/** Cài đặt → Tài khoản Zalo: kết nối nick của tài khoản đang chọn (QR, nối lại, đăng xuất), đổi tên, xoá. */
export function AccountsPage({
  account,
  accounts,
  onAccountsChanged,
  onAddAccount,
}: {
  account?: Account;
  accounts: Account[];
  onAccountsChanged: () => Promise<void>;
  onAddAccount: () => Promise<void>;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  usePolling(() => {
    api<Status>("/api/zalo/status").then(setStatus).catch(() => undefined);
  }, status?.state === "waiting_qr" || status?.state === "scanned" ? 1500 : 4000);

  const act = async (path: string) => {
    setBusy(true);
    setError("");
    try {
      await api(path, { method: "POST" });
      setStatus(await api<Status>("/api/zalo/status"));
      await onAccountsChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rename = async () => {
    if (!account) return;
    const name = prompt("Tên tài khoản:", account.name);
    if (!name?.trim()) return;
    await api(`/api/accounts/${account.id}`, { method: "PUT", body: { name } });
    await onAccountsChanged();
  };
  const removeAccount = async () => {
    if (!account) return;
    if (!confirm(`Xoá tài khoản "${account.name}"? Trợ lý đăng xuất nick này và xoá hộp thư, tính cách, lịch gửi của nó. Không hoàn tác được.`)) return;
    try {
      await api(`/api/accounts/${account.id}`, { method: "DELETE" });
      await onAccountsChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!status) return <p className="muted">Đang tải…</p>;
  const connected = status.state === "connected" || status.state === "reconnecting";

  return (
    <section className="stack">
      <div className="card stack">
        <div className="row between">
          <StatusLine status={status} accountName={account?.name ?? ""} />
          <div className="row">
            <button type="button" className="link small" onClick={rename}>
              Đổi tên
            </button>
            {accounts.length > 1 && (
              <button type="button" className="link small danger" onClick={removeAccount}>
                Xoá tài khoản
              </button>
            )}
          </div>
        </div>
        {status.state === "waiting_qr" && status.qrImage && (
          <div className="qr">
            <img src={status.qrImage} alt="Mã QR đăng nhập Zalo" />
            <ol className="small">
              <li>Mở Zalo trên điện thoại của nick sẽ gắn vào tài khoản này.</li>
              <li>Bấm biểu tượng quét mã (góc trên bên phải) và quét mã này.</li>
              <li>Xác nhận đăng nhập trên điện thoại.</li>
            </ol>
          </div>
        )}
        {!connected && !status.hasSession && status.state === "logged_out" && !status.error && (
          <div className="notice warn">
            Tài khoản này chưa gắn nick Zalo nào. Bấm <b>Đăng nhập bằng mã QR</b> rồi quét bằng nick Zalo bạn muốn gắn vào đây
            (nick khác với các tài khoản đang có).
          </div>
        )}
        {status.error && <div className="notice bad">{status.error}</div>}
        {error && <div className="notice bad">{error}</div>}
        <div className="row">
          {!connected && status.state !== "waiting_qr" && status.state !== "scanned" && (
            <button type="button" className="primary" disabled={busy} onClick={() => act("/api/zalo/login")}>
              Đăng nhập bằng mã QR
            </button>
          )}
          {!connected && status.hasSession && (status.state === "error" || status.state === "logged_out") && (
            <button type="button" disabled={busy} onClick={() => act("/api/zalo/reconnect")}>
              Kết nối lại
            </button>
          )}
          {(connected || status.hasSession) && (
            <button
              type="button"
              className="link small danger"
              disabled={busy}
              onClick={() => confirm("Đăng xuất Zalo khỏi trợ lý? Lần sau phải quét QR lại.") && act("/api/zalo/logout")}
            >
              Đăng xuất Zalo
            </button>
          )}
        </div>
        {!connected && (
          <p className="muted small">
            Kết nối dùng giao thức Zalo Web không chính thức. Zalo có thể yêu cầu đăng nhập lại hoặc hạn chế tài khoản nếu nhắn
            quá nhiều. Mỗi nick chỉ gắn vào một tài khoản. Khi trợ lý đang chạy, đừng mở Zalo Web (chat.zalo.me) bằng cùng nick.
          </p>
        )}
      </div>
      <div>
        <button type="button" onClick={() => onAddAccount().catch(() => undefined)}>
          <Plus aria-hidden />
          Thêm tài khoản Zalo
        </button>
      </div>
    </section>
  );
}

function StatusLine({ status, accountName }: { status: Status; accountName: string }) {
  const text: Record<State, string> = {
    logged_out: "Chưa kết nối Zalo",
    waiting_qr: "Đang chờ quét mã QR…",
    scanned: `${status.scannedName ?? "Điện thoại"} đã quét — hãy xác nhận trên điện thoại`,
    connecting: "Đang kết nối…",
    connected: `Đã kết nối${status.ownName ? `: ${status.ownName}` : ""}`,
    reconnecting: "Mất mạng tạm thời, đang tự nối lại…",
    error: "Có lỗi",
  };
  const dot = status.state === "connected" ? "on" : status.state === "error" ? "bad" : status.state === "waiting_qr" || status.state === "scanned" ? "wait" : "off";
  return (
    <div className="row">
      <span className={`dot ${dot}`} />
      <strong>{accountName}</strong>
      <span className="muted">· {text[status.state]}</span>
    </div>
  );
}
