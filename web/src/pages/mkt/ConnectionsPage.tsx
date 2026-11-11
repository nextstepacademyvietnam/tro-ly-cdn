import { type FormEvent, useEffect, useState } from "react";
import { BookOpen, Check, Copy, ExternalLink, Plug, RefreshCw, Settings, Unplug, X } from "lucide-react";
import { api } from "../../api";
import { timeAndDay } from "../../ui";
import { type Conn, type Kind, KindIcon, NAMES, dm, useConnections } from "./common";

const HINT: Record<Kind, string> = {
  facebook: "Cần một app Meta riêng (khoảng 5 phút) — có hướng dẫn từng bước",
  youtube: "Đăng nhập Google của chủ kênh",
  tiktok: "Đăng nhập TikTok một lần, không cần app nhà phát triển",
  meta_ads: "Dùng cùng app Meta với Facebook",
  pancake: "Dán API key và Shop ID",
  gsheet: "Ghi số mỗi ngày vào Sheet đo lường của bạn, không đè ô gõ tay",
};

export function ConnectionsPage() {
  const { data, load } = useConnections();
  const [fbOpen, setFbOpen] = useState(false);
  const [ytOpen, setYtOpen] = useState(false);
  const [pcOpen, setPcOpen] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [pick, setPick] = useState<{ pending: string; pages: { id: string; name: string }[] } | null>(null);

  // Facebook chuyển về đây sau khi đăng nhập: ?trang=mkt-ketnoi&fb=ok | chon&ma=… | loi&tb=…
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const fb = q.get("fb");
    const yt = q.get("yt");
    if (yt === "ok") setNotice({ ok: true, text: "Đã nối YouTube. App đang lấy số 120 ngày gần nhất (YouTube trễ khoảng 3 ngày)." });
    if (yt === "loi") setNotice({ ok: false, text: `Chưa nối được YouTube: ${q.get("tb") ?? "lỗi không rõ"}` });
    if (!fb && !yt) return;
    if (fb === "ok") setNotice({ ok: true, text: "Đã nối Facebook. App đang lấy số 120 ngày gần nhất, mất khoảng một phút." });
    if (fb === "loi") setNotice({ ok: false, text: `Chưa nối được Facebook: ${q.get("tb") ?? "lỗi không rõ"}` });
    if (fb === "chon" && q.get("ma")) {
      const ma = q.get("ma")!;
      api<{ pages: { id: string; name: string }[] }>(`/api/mkt/facebook/pending/${ma}`)
        .then((r) => setPick({ pending: ma, pages: r.pages }))
        .catch((err) => setNotice({ ok: false, text: (err as Error).message }));
    }
    history.replaceState(null, "", `${location.pathname}?trang=mkt-ketnoi`);
  }, []);

  // Đang lấy số thì hỏi lại mỗi 3 giây để thẻ đổi trạng thái.
  const running = data?.connections.some((c) => c.running);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [running, load]);

  const refresh = async (kind: Kind) => {
    await api("/api/mkt/refresh", { body: { kind } });
    load();
  };
  const disconnect = async (c: Conn) => {
    if (!confirm(`Ngắt ${c.name}? App xoá khoá đăng nhập, ngừng lấy số mới. Số đã lấy vẫn giữ.`)) return;
    await api(`/api/mkt/connections/${c.kind}`, { method: "DELETE" });
    load();
  };

  if (!data) return <p className="muted">Đang tải…</p>;
  const order: Kind[] = ["facebook", "youtube", "tiktok", "meta_ads", "pancake"];

  return (
    <div className="mkt-stack mkt-connect">
      <p className="muted small">App tự lấy số mỗi sáng lúc 06:00. Khoá đăng nhập được mã hoá, chỉ nằm trên máy này.</p>
      {notice && (
        <div className={notice.ok ? "notice ok row between" : "notice bad row between"} role="status">
          <span>{notice.text}</span>
          <button type="button" className="icon-only" onClick={() => setNotice(null)} aria-label="Đóng">
            <X aria-hidden />
          </button>
        </div>
      )}
      <div className="mkt-conn-grid">
        {order.map((k) => {
          const c = data.connections.find((x) => x.kind === k)!;
          return (
            <ConnCard key={k} c={c} onConnect={() => (k === "facebook" ? setFbOpen(true) : k === "youtube" ? setYtOpen(true) : k === "pancake" ? setPcOpen(true) : undefined)} onRefresh={() => refresh(k)} onDisconnect={() => disconnect(c)} />
          );
        })}
      </div>
      <div className="card mkt-sheet">
        <div className="mkt-conn-head">
          <KindIcon kind="gsheet" />
          <div className="mkt-ch-title">
            <div className="mkt-ch-name">
              Đổ số vào Google Sheet <span className="badge mkt-badge off">Sắp có</span>
            </div>
            <div className="mkt-ch-sub">{HINT.gsheet}</div>
          </div>
        </div>
        <p className="muted small">
          Bản cập nhật tới: ghép từng chỉ số với một dòng trong Sheet (VD "Lượt xem tổng Facebook"), app ghi số mỗi sáng và không đè ô bạn gõ tay.
        </p>
      </div>
      {data.runs.length > 0 && (
        <details className="card mkt-runs">
          <summary>Nhật ký lấy số ({data.runs.length})</summary>
          <ul>
            {data.runs.map((r, i) => (
              <li key={i} className={r.ok ? "" : "bad"}>
                <span className="muted tnum">{timeAndDay(r.at)}</span> · {NAMES[r.kind]}: {r.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      {fbOpen && (
        <FacebookDialog
          conn={data.connections.find((c) => c.kind === "facebook")!}
          onClose={() => setFbOpen(false)}
          onPick={(p) => {
            setFbOpen(false);
            setPick(p);
          }}
          onDone={(text) => {
            setFbOpen(false);
            setNotice({ ok: true, text });
            load();
          }}
        />
      )}
      {pcOpen && (
        <PancakeDialog
          conn={data.connections.find((c) => c.kind === "pancake")!}
          onClose={() => setPcOpen(false)}
          onDone={() => {
            setPcOpen(false);
            setNotice({ ok: true, text: "Đã nối Pancake CRM. App đang đọc toàn bộ bảng lead — bảng lớn có thể mất vài phút." });
            load();
          }}
        />
      )}
      {ytOpen && <YouTubeDialog conn={data.connections.find((c) => c.kind === "youtube")!} onClose={() => setYtOpen(false)} />}
      {pick && (
        <PagePicker
          pick={pick}
          onClose={() => setPick(null)}
          onDone={(name) => {
            setPick(null);
            setNotice({ ok: true, text: `Đã nối trang ${name}. App đang lấy số 120 ngày gần nhất, mất khoảng một phút.` });
            load();
          }}
        />
      )}
    </div>
  );
}

function ConnCard({ c, onConnect, onRefresh, onDisconnect }: { c: Conn; onConnect: () => void; onRefresh: () => void; onDisconnect: () => void }) {
  const badge =
    c.status === "ok" ? <span className="badge mkt-badge ok">Đã nối</span> : c.status === "error" ? <span className="badge mkt-badge bad">Lỗi</span> : <span className="badge mkt-badge off">{c.available ? "Chưa nối" : "Sắp có"}</span>;
  const sub =
    c.status === "off"
      ? HINT[c.kind]
      : `${c.label || "—"} · ${c.running ? "đang lấy số…" : c.pulledAt ? `lấy số lúc ${timeAndDay(c.pulledAt)}` : "chưa lấy số"}${c.dataUntil ? ` · số tới ${dm(c.dataUntil)}` : ""}`;
  return (
    <div className="card mkt-conn">
      <div className="mkt-conn-head">
        <KindIcon kind={c.kind} />
        <div className="mkt-ch-title">
          <div className="mkt-ch-name">
            {c.name}
            {badge}
          </div>
          <div className="mkt-ch-sub" title={sub}>
            {sub}
          </div>
        </div>
      </div>
      {c.status === "error" && <div className="mkt-err-box">{c.error}</div>}
      <div className="row">
        {!c.available ? null : c.status === "off" ? (
          <button type="button" className="primary" onClick={onConnect}>
            <Plug aria-hidden />
            Kết nối
          </button>
        ) : (
          <>
            {c.status === "error" ? (
              <button type="button" className="primary" onClick={onConnect}>
                <Plug aria-hidden />
                Nối lại
              </button>
            ) : (
              <button type="button" onClick={onRefresh} disabled={c.running}>
                <RefreshCw aria-hidden className={c.running ? "spin" : ""} />
                {c.running ? "Đang lấy số…" : "Làm mới"}
              </button>
            )}
            <button type="button" onClick={onConnect}>
              <Settings aria-hidden />
              Cài đặt
            </button>
            <button type="button" className="icon-only push" onClick={onDisconnect} title="Ngắt kết nối" aria-label="Ngắt kết nối">
              <Unplug aria-hidden />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function FacebookDialog({
  conn,
  onClose,
  onPick,
  onDone,
}: {
  conn: Conn;
  onClose: () => void;
  onPick: (p: { pending: string; pages: { id: string; name: string }[] }) => void;
  onDone: (text: string) => void;
}) {
  const [mode, setMode] = useState<"app" | "token">("app");
  const [appId, setAppId] = useState(conn.appId ?? "");
  const [appSecret, setAppSecret] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const redirect = `${location.origin}/api/mkt/oauth/facebook/callback`;

  const login = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (appSecret || !conn.hasApp || appId !== conn.appId) await api("/api/mkt/facebook/app", { body: { appId, appSecret } });
      const r = await api<{ url: string }>("/api/mkt/facebook/login");
      location.href = r.url;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  const paste = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api<{ connected?: string; pending?: string; pages?: { id: string; name: string }[] }>("/api/mkt/facebook/token", { body: { token } });
      if (r.pending && r.pages) onPick({ pending: r.pending, pages: r.pages });
      else onDone(`Đã nối trang ${r.connected}. App đang lấy số 120 ngày gần nhất, mất khoảng một phút.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-body card mkt-dialog" role="dialog" aria-label="Kết nối Facebook" onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <h2>Kết nối Fanpage Facebook</h2>
          <button type="button" className="icon-only" onClick={onClose} aria-label="Đóng">
            <X aria-hidden />
          </button>
        </div>
        <div className="grp-seg" role="tablist">
          <button type="button" role="tab" aria-selected={mode === "app"} onClick={() => setMode("app")}>
            Đăng nhập Facebook
          </button>
          <button type="button" role="tab" aria-selected={mode === "token"} onClick={() => setMode("token")}>
            Dán token có sẵn
          </button>
        </div>
        {mode === "app" ? (
          <form className="form-scroll stack" onSubmit={login}>
            <ol className="mkt-steps small">
              <li>
                Vào{" "}
                <a href="https://developers.facebook.com/apps/" target="_blank" rel="noreferrer">
                  developers.facebook.com/apps <ExternalLink className="icon-inline" aria-hidden />
                </a>{" "}
                bằng tài khoản quản trị Fanpage, bấm <b>Tạo ứng dụng</b>. Chọn loại <b>Doanh nghiệp</b> (hoặc "Khác"), đặt tên tuỳ ý.
              </li>
              <li>
                Trong app, thêm sản phẩm <b>Đăng nhập bằng Facebook</b>. Ở phần cài đặt của nó, dán địa chỉ dưới đây vào ô <b>URI chuyển hướng OAuth hợp lệ</b> rồi lưu:
                <span className="mkt-copy">
                  <code>{redirect}</code>
                  <button
                    type="button"
                    className="icon-only"
                    aria-label="Chép địa chỉ"
                    onClick={async () => {
                      await navigator.clipboard.writeText(redirect).catch(() => undefined);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    }}
                  >
                    {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
                  </button>
                </span>
              </li>
              <li>
                Vào <b>Cài đặt → Cơ bản</b>, chép <b>ID ứng dụng</b> và <b>Khoá bí mật của ứng dụng</b> (bấm Hiện) vào hai ô dưới. Để app ở chế độ <b>Phát triển</b> là đủ.
              </li>
            </ol>
            <label>
              App ID
              <input value={appId} onChange={(e) => setAppId(e.target.value.trim())} inputMode="numeric" placeholder="VD: 1234567890123456" required />
            </label>
            <label>
              App Secret
              <input
                type="password"
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value.trim())}
                placeholder={conn.hasApp ? "Đã lưu — để trống nếu không đổi" : "Dãy 32 ký tự"}
                required={!conn.hasApp}
                autoComplete="off"
              />
            </label>
            <p className="muted small">Bấm nút dưới, Facebook hỏi bạn cho phép app đọc số liệu trang. Cho phép xong sẽ quay lại đây.</p>
            {error && <div className="notice bad small">{error}</div>}
            <div className="row">
              <button type="submit" className="primary" disabled={busy || !appId}>
                {busy ? "Đang mở Facebook…" : "Đăng nhập Facebook"}
              </button>
              <a className="small" href="https://developers.facebook.com/docs/development/create-an-app/" target="_blank" rel="noreferrer">
                <BookOpen className="icon-inline" aria-hidden /> Hướng dẫn của Meta
              </a>
            </div>
          </form>
        ) : (
          <form className="stack" onSubmit={paste}>
            <p className="small">
              Đã có token trang hoặc token người dùng (VD lấy từ Graph API Explorer, hay token của hệ thống cũ)? Dán vào đây. Token người dùng thì app hỏi bạn chọn trang.
            </p>
            <label>
              Token
              <textarea rows={3} value={token} onChange={(e) => setToken(e.target.value.trim())} placeholder="EAAG…" autoComplete="off" />
            </label>
            <p className="muted small">Token trang lấy từ token người dùng dài hạn thì không hết hạn. Token ngắn hạn (1–2 giờ) sẽ sớm báo lỗi và phải dán lại.</p>
            {error && <div className="notice bad small">{error}</div>}
            <div className="row">
              <button type="submit" className="primary" disabled={busy || token.length < 20}>
                {busy ? "Đang kiểm tra…" : "Kiểm tra và nối"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function PagePicker({ pick, onClose, onDone }: { pick: { pending: string; pages: { id: string; name: string }[] }; onClose: () => void; onDone: (name: string) => void }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const choose = async (id: string) => {
    setBusy(id);
    setError("");
    try {
      const r = await api<{ connected: string }>("/api/mkt/facebook/choose", { body: { pending: pick.pending, pageId: id } });
      onDone(r.connected);
    } catch (err) {
      setError((err as Error).message);
      setBusy("");
    }
  };
  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-body card mkt-dialog narrow" role="dialog" aria-label="Chọn trang" onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <h2>Chọn Fanpage để đo</h2>
          <button type="button" className="icon-only" onClick={onClose} aria-label="Đóng">
            <X aria-hidden />
          </button>
        </div>
        <p className="muted small">Tài khoản này quản lý {pick.pages.length} trang. Chọn một trang; muốn đổi thì nối lại sau.</p>
        <div className="mkt-pick">
          {pick.pages.map((p) => (
            <button key={p.id} type="button" className="menu-item" onClick={() => choose(p.id)} disabled={Boolean(busy)}>
              <span className="menu-text">
                <span>{p.name}</span>
                <span className="menu-sub tnum">ID {p.id}</span>
              </span>
              {busy === p.id && <RefreshCw className="spin" aria-hidden />}
            </button>
          ))}
        </div>
        {error && <div className="notice bad small">{error}</div>}
      </div>
    </div>
  );
}

function YouTubeDialog({ conn, onClose }: { conn: Conn; onClose: () => void }) {
  const [json, setJson] = useState("");
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const redirect = `${location.origin}/api/mkt/oauth/youtube/callback`;
  const login = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (json) await api("/api/mkt/youtube/client", { body: { json } });
      const r = await api<{ url: string }>("/api/mkt/youtube/login");
      location.href = r.url;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-body card mkt-dialog" role="dialog" aria-label="Kết nối YouTube" onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <h2>Kết nối kênh YouTube</h2>
          <button type="button" className="icon-only" onClick={onClose} aria-label="Đóng">
            <X aria-hidden />
          </button>
        </div>
        <form className="form-scroll stack" onSubmit={login}>
          <ol className="mkt-steps small">
            <li>
              Vào{" "}
              <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">
                Google Cloud <ExternalLink className="icon-inline" aria-hidden />
              </a>{" "}
              tạo một dự án (tên tuỳ ý). Trong <b>Thư viện API</b>, bật <b>YouTube Data API v3</b> và <b>YouTube Analytics API</b>.
            </li>
            <li>
              Vào <b>Màn hình xin quyền OAuth</b>: chọn loại <b>Bên ngoài</b>, điền tên app và email, rồi bấm <b>Xuất bản ứng dụng</b> (Đang hoạt động). Để chế độ Thử nghiệm thì Google tự thu hồi quyền sau 7 ngày.
            </li>
            <li>
              Vào <b>Thông tin xác thực → Tạo → ID ứng dụng OAuth</b>, loại <b>Ứng dụng dành cho máy tính</b>. Tạo xong bấm <b>Tải xuống JSON</b> và chọn file đó ở ô dưới.
            </li>
            <li>Bấm Đăng nhập Google bằng <b>tài khoản chủ kênh</b> (tài khoản chỉ là quản lý/biên tập viên thì Google không cho đọc số). Google báo "chưa xác minh" thì bấm <b>Nâng cao → Tiếp tục</b>: đó là app của chính bạn.</li>
          </ol>
          <label>
            File JSON client {conn.hasApp && <span className="muted small">(đã có — chọn file khác nếu muốn đổi)</span>}
            <input
              type="file"
              accept="application/json,.json"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                setError("");
                if (!file) return;
                setFileName(file.name);
                setJson(await file.text());
              }}
            />
          </label>
          {fileName && <p className="muted small">Đã chọn: {fileName}</p>}
          <p className="muted small">
            Địa chỉ app nhận lại sau khi đăng nhập (Google tự cho phép với loại Ứng dụng máy tính):
            <span className="mkt-copy">
              <code>{redirect}</code>
              <button
                type="button"
                className="icon-only"
                aria-label="Chép địa chỉ"
                onClick={async () => {
                  await navigator.clipboard.writeText(redirect).catch(() => undefined);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
              </button>
            </span>
          </p>
          {error && <div className="notice bad small">{error}</div>}
          <div className="row">
            <button type="submit" className="primary" disabled={busy || (!json && !conn.hasApp)}>
              {busy ? "Đang mở Google…" : "Đăng nhập Google"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface LeadRules {
  channels: Record<string, { prefix: string[]; exact: string[] }>;
  founderTitles: string[];
  contactTable: string;
  workshopTable: string;
}

function PancakeDialog({ conn, onClose, onDone }: { conn: Conn; onClose: () => void; onDone: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [shopId, setShopId] = useState(conn.label.replace(/^Shop /, ""));
  const [rulesText, setRulesText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const connected = conn.status !== "off";
  useEffect(() => {
    api<{ rules: LeadRules }>("/api/mkt/pancake/rules")
      .then((r) => setRulesText(JSON.stringify(r.rules, null, 2)))
      .catch(() => undefined);
  }, []);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      let rules: LeadRules | null = null;
      if (rulesText.trim()) {
        try {
          rules = JSON.parse(rulesText) as LeadRules;
        } catch {
          throw new Error("Luật nguồn lead không đúng định dạng JSON");
        }
        await api("/api/mkt/pancake/rules", { method: "PUT", body: { rules } });
      }
      if (apiKey || !connected || shopId !== conn.label.replace(/^Shop /, "")) await api("/api/mkt/pancake", { body: { apiKey, shopId } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-body card mkt-dialog" role="dialog" aria-label="Kết nối Pancake CRM" onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <h2>Kết nối Pancake CRM</h2>
          <button type="button" className="icon-only" onClick={onClose} aria-label="Đóng">
            <X aria-hidden />
          </button>
        </div>
        <form className="form-scroll stack" onSubmit={save}>
          <ol className="mkt-steps small">
            <li>
              Mở{" "}
              <a href="https://pos.pancake.vn" target="_blank" rel="noreferrer">
                Pancake POS <ExternalLink className="icon-inline" aria-hidden />
              </a>
              , vào shop có bảng lead. <b>Shop ID</b> là dãy số trên thanh địa chỉ (pos.pancake.vn/shop/<b>dãy số</b>/…).
            </li>
            <li>
              Vào <b>Cấu hình → Kết nối ứng dụng / API</b> (tên mục có thể hơi khác), tạo <b>API key</b> rồi dán vào dưới. App chỉ đọc, không sửa gì trong CRM.
            </li>
          </ol>
          <label>
            Shop ID
            <input value={shopId} onChange={(e) => setShopId(e.target.value.trim())} inputMode="numeric" placeholder="VD: 430111447" required />
          </label>
          <label>
            API key
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={connected ? "Đã lưu — để trống nếu không đổi" : "Dán API key"} required={!connected} autoComplete="off" />
          </label>
          <details>
            <summary>Luật nguồn lead (nâng cao)</summary>
            <p className="muted small">
              App xếp mỗi lead vào một nguồn theo cột "nguồn khách hàng" của bảng <b>contactTable</b>: khớp đúng một câu trong <b>exact</b> hoặc bắt đầu bằng một câu trong <b>prefix</b> (không phân biệt hoa thường). Không khớp, hoặc lead có mã quảng cáo,
              thì vào "Khác, chưa rõ". Bảng <b>workshopTable</b> đếm riêng người đăng ký workshop. <b>founderTitles</b> là các chức danh tính là founder.
            </p>
            <textarea rows={12} className="mkt-code" value={rulesText} onChange={(e) => setRulesText(e.target.value)} spellCheck={false} />
          </details>
          {error && <div className="notice bad small">{error}</div>}
          <div className="row">
            <button type="submit" className="primary" disabled={busy || !shopId}>
              {busy ? "Đang kiểm tra…" : connected ? "Lưu" : "Kiểm tra và nối"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
