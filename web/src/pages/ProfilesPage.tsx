import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { type Account, type Profile, api, ApiError, readAsBase64 } from "../api";
import {
  EMPTY_IDENTITY,
  type Faq,
  IDENTITY_FIELDS,
  type Identity,
  type TimelyNote,
  daysAgo,
  fmtDate,
  fmtDay,
  identityLength,
} from "../layers";

const ACCEPT = ".txt,.md,.docx,.pdf";
type Settings = Pick<Profile, "name" | "tag" | "sendMode" | "applies" | "priority">;
type Draft = Settings & { identity: Identity };
const EMPTY: Draft = { name: "", tag: "", sendMode: "draft", applies: "both", priority: 100, identity: EMPTY_IDENTITY };
const toDraft = (p: Profile): Draft => ({
  name: p.name,
  tag: p.tag,
  sendMode: p.sendMode,
  applies: p.applies,
  priority: p.priority,
  identity: { ...EMPTY_IDENTITY, ...p.identity },
});
const same = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);
const todayVN = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);

/** Trang Tính cách: nhiều hồ sơ, mỗi hồ sơ gắn một nhãn Zalo; hướng dẫn AI chia 4 tầng theo mức độ thay đổi. */
export function ProfilesPage({ accounts, accountId, onNeedEngine }: { accounts: Account[]; accountId: number; onNeedEngine: () => void }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [offTag, setOffTag] = useState("Không bot");
  const [labels, setLabels] = useState<string[]>([]);
  const [labelsConnected, setLabelsConnected] = useState(true);
  const [labelCounts, setLabelCounts] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<number | "new" | null>(null);
  const [copying, setCopying] = useState(false);

  const load = useCallback(async () => {
    const r = await api<{ profiles: Profile[]; offTag: string }>("/api/profiles");
    setProfiles(r.profiles);
    setOffTag(r.offTag);
    setSelected((cur) => (cur === "new" || r.profiles.some((p) => p.id === cur) ? cur : (r.profiles[0]?.id ?? "new")));
  }, []);
  useEffect(() => {
    load();
    api<{ labels: string[]; connected: boolean; details: { name: string; count: number }[] }>("/api/zalo/labels")
      .then((r) => {
        setLabels(r.labels);
        setLabelsConnected(r.connected);
        setLabelCounts(Object.fromEntries(r.details.map((d) => [d.name.toLocaleLowerCase("vi"), d.count])));
      })
      .catch(() => setLabelsConnected(false));
  }, [load]);

  const current = typeof selected === "number" ? profiles.find((p) => p.id === selected) : undefined;
  const editorProps = { labels, labelCounts, labelsConnected, offTag, onNeedEngine };

  return (
    <section className="profiles">
      <aside className="profile-list card">
        <div className="row between">
          <strong>Tính cách</strong>
          <button className="small-btn primary" onClick={() => setSelected("new")}>
            + Thêm
          </button>
        </div>
        <p className="muted small">
          Mỗi tính cách gắn với một <b>nhãn Zalo thật</b>. Gắn nhãn đó cho người/nhóm nào — trên điện thoại, máy tính hay ở Hộp thư —
          trợ lý trả lời họ bằng tính cách ấy. Nhãn <b>{offTag}</b> tắt trợ lý.
        </p>
        <ul>
          {profiles.map((p) => (
            <li key={p.id}>
              <button className={selected === p.id ? "profile-item active" : "profile-item"} onClick={() => setSelected(p.id)}>
                <strong>{p.name}</strong>
                <span className="small muted">
                  {p.tag ? `🏷 ${p.tag}` : "Chưa gắn nhãn"} · {p.sendMode === "auto" ? "Tự gửi" : "Soạn nháp"}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <LayerLegend />
        {accounts.length > 1 && profiles.length > 0 && (
          <button className="link small" onClick={() => setCopying(true)}>
            Sao chép sang tài khoản khác…
          </button>
        )}
      </aside>

      {selected === "new" ? (
        <ProfileEditor key="new" {...editorProps} onSaved={(id) => load().then(() => setSelected(id))} />
      ) : current ? (
        <ProfileEditor
          key={current.id}
          {...editorProps}
          profile={current}
          onSaved={() => load()}
          onDeleted={() => {
            setSelected(null);
            load();
          }}
        />
      ) : (
        <p className="muted">Chọn hoặc thêm một tính cách.</p>
      )}

      {copying && <CopyDialog profiles={profiles} accounts={accounts.filter((a) => a.id !== accountId)} onClose={() => setCopying(false)} />}
    </section>
  );
}

/** Chú thích 4 tầng ở cột trái. */
function LayerLegend() {
  return (
    <div className="legend small">
      <strong>Hướng dẫn AI có 4 tầng</strong>
      <span>
        <i className="lay lay0">0</i> Luật an toàn — app giữ, không đổi
      </span>
      <span>
        <i className="lay lay1">1</i> Danh tính — <b>ít đổi</b> (vài tháng)
      </span>
      <span>
        <i className="lay lay2">2</i> Kiến thức — <b>thỉnh thoảng</b>
      </span>
      <span>
        <i className="lay lay3">3</i> Thời điểm — <b>thường xuyên</b>
      </span>
    </div>
  );
}

function Layer({ n, title, freq, intro, children, right }: { n: 0 | 1 | 2 | 3; title: string; freq: string; intro: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div className={`card stack layer layer-${n}`}>
      <div className="row between">
        <div className="row">
          <i className={`lay lay${n}`}>{n}</i>
          <strong>{title}</strong>
          <span className="freq">{freq}</span>
        </div>
        {right}
      </div>
      <p className="muted small">{intro}</p>
      {children}
    </div>
  );
}

function ProfileEditor({
  profile,
  labels,
  labelCounts,
  labelsConnected,
  offTag,
  onSaved,
  onDeleted,
  onNeedEngine,
}: {
  profile?: Profile;
  labels: string[];
  labelCounts: Record<string, number>;
  labelsConnected: boolean;
  offTag: string;
  onSaved: (id: number) => void;
  onDeleted?: () => void;
  onNeedEngine: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(profile ? toDraft(profile) : EMPTY);
  const [saved, setSaved] = useState<Draft>(profile ? toDraft(profile) : EMPTY);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [side, setSide] = useState<"test" | "optimize">("test");
  const [preview, setPreview] = useState<{ system: string } | null>(null);
  const [frame, setFrame] = useState("");
  const promptFileRef = useRef<HTMLInputElement>(null);
  const dirty = !same(draft, saved);
  const set = (patch: Partial<Settings>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setMessage("");
  };
  const setField = (key: keyof Identity, value: string) => {
    setDraft((d) => ({ ...d, identity: { ...d.identity, [key]: value } }));
    setMessage("");
  };

  const save = async () => {
    setBusy("save");
    try {
      if (profile) {
        await api(`/api/profiles/${profile.id}`, { method: "PUT", body: draft });
        setSaved(draft);
        setMessage("Đã lưu.");
        onSaved(profile.id);
      } else {
        const r = await api<{ profile: Profile }>("/api/profiles", { body: draft });
        onSaved(r.profile.id);
      }
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy("");
    }
  };

  const remove = async () => {
    if (!profile || !confirm(`Xoá tính cách "${profile.name}" cùng tài liệu, hỏi đáp, ghi chú của nó?`)) return;
    await api(`/api/profiles/${profile.id}`, { method: "DELETE" });
    onDeleted?.();
  };

  const loadPromptFromFile = async (file?: File) => {
    if (!file) return;
    setBusy("file");
    try {
      const r = await api<{ text: string }>("/api/extract-text", { body: { name: file.name, dataBase64: await readAsBase64(file) } });
      setField("notes", draft.identity.notes ? `${draft.identity.notes}\n\n${r.text}` : r.text);
      setMessage(`Đã nạp "${file.name}" vào ô "Ghi chú thêm". Có thể nhờ "Tối ưu với AI" tách vào đúng ô, rồi bấm Lưu.`);
    } catch (err) {
      setMessage(`${file.name}: ${(err as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  const showPreview = async () => {
    if (!profile) return;
    setPreview(await api<{ system: string }>(`/api/profiles/${profile.id}/preview`, { body: { identity: draft.identity } }));
  };
  const loadFrame = async () => {
    if (!profile || frame) return;
    const r = await api<{ frame: string }>(`/api/profiles/${profile.id}/preview`, { body: {} });
    setFrame(r.frame);
  };

  const tagCount = labelCounts[draft.tag.trim().toLocaleLowerCase("vi")] ?? 0;

  return (
    <div className="split">
      <div className="stack">
        {/* ---------- Cài đặt ---------- */}
        <div className="card stack">
          <div className="row between">
            <h2>{profile ? profile.name : "Tính cách mới"}</h2>
            <div className="row">
              {profile && (
                <button className="small-btn" onClick={showPreview}>
                  👁 Xem hướng dẫn AI nhận được
                </button>
              )}
              {profile && (
                <button className="link danger small" onClick={remove}>
                  Xoá
                </button>
              )}
            </div>
          </div>
          <div className="grid-2">
            <label>
              Tên tính cách
              <input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="VD: Chăm sóc khách hàng" />
            </label>
            <TagPicker value={draft.tag} labels={labels.filter((l) => l !== offTag)} connected={labelsConnected} onChange={(tag) => set({ tag })} />
            <label>
              Áp dụng cho
              <select value={draft.applies} onChange={(e) => set({ applies: e.target.value as Draft["applies"] })}>
                <option value="both">Chat riêng và nhóm</option>
                <option value="user">Chỉ chat riêng</option>
                <option value="group">Chỉ nhóm</option>
              </select>
            </label>
            <label>
              Cách gửi
              <select value={draft.sendMode} onChange={(e) => set({ sendMode: e.target.value as Draft["sendMode"] })}>
                <option value="draft">Soạn nháp, chờ tôi duyệt</option>
                <option value="auto">Tự gửi</option>
              </select>
            </label>
            <label>
              Ưu tiên <span className="muted small">(số nhỏ thắng khi một hội thoại có nhiều nhãn)</span>
              <input type="number" min={1} max={999} value={draft.priority} onChange={(e) => set({ priority: Number(e.target.value) })} />
            </label>
          </div>
          {draft.tag && tagCount > 0 && (
            <div className={tagCount > 20 ? "notice warn small" : "muted small"}>
              Nhãn "{draft.tag}" đang gắn cho <b>{tagCount}</b> hội thoại trong Zalo — trợ lý sẽ {draft.sendMode === "auto" ? "tự trả lời" : "soạn nháp cho"} tất cả họ
              khi họ nhắn tới.{tagCount > 20 && ' Nên dùng một nhãn riêng cho trợ lý (VD "Bot CSKH") và gắn dần cho từng khách.'}
            </div>
          )}
          {draft.tag && labelsConnected && !labels.some((l) => l.toLocaleLowerCase("vi") === draft.tag.trim().toLocaleLowerCase("vi")) && (
            <div className="notice warn small">
              Zalo chưa có nhãn "{draft.tag}". Nhãn sẽ được tạo trong Zalo ở lần đầu bạn gắn nó cho một hội thoại tại Hộp thư.
            </div>
          )}
        </div>

        {/* ---------- Tầng 0 ---------- */}
        {profile && (
          <details className="card layer layer-0" onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && loadFrame()}>
            <summary className="row">
              <i className="lay lay0">0</i>
              <strong>Luật an toàn</strong>
              <span className="freq">Không đổi · app giữ</span>
              <span className="muted small">— bấm để xem</span>
            </summary>
            <p className="muted small">
              App luôn đặt các luật này lên đầu, cho mọi tính cách: không bịa giá, không xác nhận đã nhận tiền, không lộ thông tin khách khác, khi
              nào chuyển người thật, khi nào im lặng. Bạn không cần (và không thể) viết lại — chỉ bổ sung ở tầng 1.
            </p>
            {frame ? <pre className="doc-text">{frame}</pre> : <p className="muted small">Đang tải…</p>}
          </details>
        )}

        {/* ---------- Tầng 1 ---------- */}
        <Layer
          n={1}
          title="Danh tính & nguyên tắc"
          freq="Ít đổi · vài tháng một lần"
          intro="Những điều bền vững về trợ lý: là ai, mục tiêu, giọng, được và không được làm. Không ghi giá, khuyến mãi hay lịch ở đây — những thứ đó đổi thường xuyên, để ở tầng 2 và 3."
          right={
            <button className="link small" onClick={() => promptFileRef.current?.click()} disabled={busy !== ""}>
              Nạp từ file…
            </button>
          }
        >
          <input ref={promptFileRef} type="file" accept={ACCEPT} hidden onChange={(e) => (loadPromptFromFile(e.target.files?.[0]), (e.target.value = ""))} />
          {IDENTITY_FIELDS.map((f) => (
            <label key={f.key} className="field">
              <span>
                {f.title} <span className="muted small">— {f.hint}</span>
              </span>
              <textarea rows={f.rows} value={draft.identity[f.key]} placeholder={f.example} onChange={(e) => setField(f.key, e.target.value)} />
            </label>
          ))}
          <div className="row">
            <button className="primary" onClick={save} disabled={(!dirty && !!profile) || busy !== ""}>
              {profile ? "Lưu cài đặt và tầng 1" : "Tạo tính cách"}
            </button>
            {dirty && profile && (
              <>
                <span className="muted small">Chưa lưu — khung chat thử bên cạnh đang dùng bản này</span>
                <button className="link small" onClick={() => setDraft(saved)}>
                  Hoàn tác
                </button>
              </>
            )}
            <span className="muted small push">{identityLength(draft.identity).toLocaleString("vi-VN")} ký tự</span>
          </div>
          {message && <p className="muted small">{message}</p>}
        </Layer>

        {profile ? (
          <>
            <KnowledgeLayer profile={profile} onChanged={() => onSaved(profile.id)} />
            <TimelyLayer profile={profile} onChanged={() => onSaved(profile.id)} />
          </>
        ) : (
          <p className="muted small">Tạo tính cách xong là thêm được tài liệu, hỏi đáp (tầng 2) và thông tin thời điểm (tầng 3).</p>
        )}
      </div>

      <div className="split-side card">
        {profile ? (
          <>
            <div className="seg">
              <button className={side === "test" ? "active" : ""} onClick={() => setSide("test")}>
                Chat thử
              </button>
              <button className={side === "optimize" ? "active" : ""} onClick={() => setSide("optimize")}>
                ✨ Tối ưu với AI
              </button>
            </div>
            <div hidden={side !== "test"}>
              <TestChat profileId={profile.id} identity={draft.identity} onNeedEngine={onNeedEngine} />
            </div>
            <div hidden={side !== "optimize"}>
              <OptimizeChat
                profileId={profile.id}
                identity={draft.identity}
                onApply={(identity) => {
                  setDraft((d) => ({ ...d, identity }));
                  setSide("test");
                  setMessage("Đã áp dụng tầng 1 AI đề xuất. Chat thử bên cạnh rồi bấm Lưu nếu ưng.");
                }}
                onAdded={() => onSaved(profile.id)}
                onNeedEngine={onNeedEngine}
              />
            </div>
          </>
        ) : (
          <p className="muted small">Tạo tính cách xong là chat thử và tối ưu được ở đây.</p>
        )}
      </div>

      {preview && (
        <Modal title="Hướng dẫn AI nhận được (tầng 0 → 3)" onClose={() => setPreview(null)}>
          <p className="muted small">
            Đây là toàn bộ văn bản AI đọc trước mỗi câu trả lời trong chat riêng (tầng 1 lấy bản đang soạn). Phía sau là lịch sử hội thoại với khách.
          </p>
          <pre className="doc-text">{preview.system}</pre>
        </Modal>
      )}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal" onClick={onClose}>
      <div className="card modal-body" onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <strong>{title}</strong>
          <button className="link" onClick={onClose}>
            Đóng
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ---------- Tầng 2: tài liệu + hỏi đáp ---------- */
function KnowledgeLayer({ profile, onChanged }: { profile: Profile; onChanged: () => void }) {
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [viewing, setViewing] = useState<{ name: string; text: string } | null>(null);
  const [newFaq, setNewFaq] = useState<Faq>({ question: "", answer: "" });
  const [editing, setEditing] = useState<Faq | null>(null);
  const docRef = useRef<HTMLInputElement>(null);

  const uploadDocs = async (list: FileList | null) => {
    if (!list?.length) return;
    for (const f of Array.from(list)) {
      setBusy(`Đang đọc ${f.name}…`);
      try {
        await api(`/api/profiles/${profile.id}/files`, { body: { name: f.name, dataBase64: await readAsBase64(f) } });
      } catch (err) {
        setMessage(`${f.name}: ${(err as Error).message}`);
      }
    }
    setBusy("");
    onChanged();
  };
  const saveFaq = async (faq: Faq) => {
    try {
      if (faq.id) await api(`/api/profiles/${profile.id}/faqs/${faq.id}`, { method: "PUT", body: faq });
      else await api(`/api/profiles/${profile.id}/faqs`, { body: faq });
      setNewFaq({ question: "", answer: "" });
      setEditing(null);
      setMessage("");
      onChanged();
    } catch (err) {
      setMessage((err as Error).message);
    }
  };

  return (
    <Layer
      n={2}
      title="Kiến thức sản phẩm"
      freq="Thỉnh thoảng · khi đổi sản phẩm, giá, chính sách"
      intro="Bảng giá, mô tả sản phẩm, chính sách, quy trình — trợ lý chỉ trả lời theo những gì có ở đây. Câu hỏi khách hay hỏi thì ghi thẳng vào phần hỏi đáp."
      right={
        <button className="small-btn" onClick={() => docRef.current?.click()} disabled={busy !== ""}>
          {busy || "+ Tải tài liệu"}
        </button>
      }
    >
      <input ref={docRef} type="file" accept={ACCEPT} multiple hidden onChange={(e) => (uploadDocs(e.target.files), (e.target.value = ""))} />
      <strong className="small">Tài liệu (.txt, .md, .docx, .pdf có chữ)</strong>
      {profile.files.length === 0 ? (
        <p className="muted small">Chưa có tài liệu nào.</p>
      ) : (
        <ul className="files">
          {profile.files.map((f) => (
            <li key={f.id}>
              <span className="file-name">📄 {f.name}</span>
              <span className="muted small">
                {f.chars.toLocaleString("vi-VN")} ký tự · cập nhật {fmtDate(f.created_at)}
              </span>
              <button className="link" onClick={async () => setViewing(await api(`/api/profile-files/${f.id}`))}>
                Xem
              </button>
              <button
                className="link danger"
                onClick={async () => {
                  if (!confirm(`Xoá tài liệu "${f.name}"?`)) return;
                  await api(`/api/profile-files/${f.id}`, { method: "DELETE" });
                  onChanged();
                }}
              >
                Xoá
              </button>
            </li>
          ))}
        </ul>
      )}

      <strong className="small">Câu hỏi thường gặp ({profile.faqs.length})</strong>
      <ul className="faqs">
        {profile.faqs.map((f) =>
          editing?.id === f.id ? (
            <li key={f.id}>
              <FaqForm value={editing!} onChange={setEditing} onSave={() => saveFaq(editing!)} onCancel={() => setEditing(null)} />
            </li>
          ) : (
            <li key={f.id}>
              <div>
                <b>Hỏi:</b> {f.question}
              </div>
              <div>
                <b>Đáp:</b> {f.answer}
              </div>
              <div className="row small">
                <span className="muted">cập nhật {f.updatedAt ? fmtDate(f.updatedAt) : ""}</span>
                <button className="link small" onClick={() => setEditing(f)}>
                  Sửa
                </button>
                <button
                  className="link small danger"
                  onClick={async () => {
                    await api(`/api/profiles/${profile.id}/faqs/${f.id}`, { method: "DELETE" });
                    onChanged();
                  }}
                >
                  Xoá
                </button>
              </div>
            </li>
          ),
        )}
      </ul>
      <FaqForm value={newFaq} onChange={setNewFaq} onSave={() => saveFaq(newFaq)} />
      {message && <p className="muted small">{message}</p>}
      {viewing && (
        <Modal title={viewing.name} onClose={() => setViewing(null)}>
          <pre className="doc-text">{viewing.text}</pre>
        </Modal>
      )}
    </Layer>
  );
}

function FaqForm({ value, onChange, onSave, onCancel }: { value: Faq; onChange: (f: Faq) => void; onSave: () => void; onCancel?: () => void }) {
  return (
    <div className="faq-form">
      <input value={value.question} onChange={(e) => onChange({ ...value, question: e.target.value })} placeholder="Câu hỏi — VD: Khoá học có học online không?" />
      <textarea rows={2} value={value.answer} onChange={(e) => onChange({ ...value, answer: e.target.value })} placeholder="Câu trả lời — VD: Dạ khoá học trực tuyến qua Zoom, có ghi hình xem lại ạ." />
      <div className="row">
        <button className="small-btn" onClick={onSave} disabled={!value.question.trim() || !value.answer.trim()}>
          {value.id ? "Lưu câu hỏi" : "+ Thêm câu hỏi"}
        </button>
        {onCancel && (
          <button className="link small" onClick={onCancel}>
            Huỷ
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------- Tầng 3: thông tin thời điểm ---------- */
function TimelyLayer({ profile, onChanged }: { profile: Profile; onChanged: () => void }) {
  const [form, setForm] = useState<TimelyNote>({ text: "", expiresOn: null });
  const [editing, setEditing] = useState<TimelyNote | null>(null);
  const [message, setMessage] = useState("");
  const today = todayVN();
  const lastUpdate = profile.notes.reduce((m, n) => Math.max(m, n.updatedAt ?? 0), 0);
  const stale = profile.tag && (!lastUpdate || daysAgo(lastUpdate) > 7);

  const save = async (n: TimelyNote) => {
    try {
      if (n.id) await api(`/api/profiles/${profile.id}/notes/${n.id}`, { method: "PUT", body: n });
      else await api(`/api/profiles/${profile.id}/notes`, { body: n });
      setForm({ text: "", expiresOn: null });
      setEditing(null);
      setMessage("");
      onChanged();
    } catch (err) {
      setMessage((err as Error).message);
    }
  };

  return (
    <Layer
      n={3}
      title="Thông tin thời điểm"
      freq="Thường xuyên · hằng tuần, hằng ngày"
      intro="Khuyến mãi đang chạy, lịch khai giảng, số chỗ còn, lịch nghỉ… Mỗi dòng nên có ngày hết hạn: hết hạn là tự rời khỏi hướng dẫn, chuông 🔔 nhắc trước 2 ngày. Thông tin ở đây được ưu tiên hơn tài liệu tầng 2."
      right={
        <span className={stale ? "freq warn" : "muted small"}>
          {lastUpdate ? `Cập nhật ${daysAgo(lastUpdate) === 0 ? "hôm nay" : `${daysAgo(lastUpdate)} ngày trước`}` : "Chưa có"}
        </span>
      }
    >
      {stale && <div className="notice warn small">Tầng 3 đã lâu chưa cập nhật — kiểm tra khuyến mãi, lịch, số chỗ còn có còn đúng không.</div>}
      <ul className="notes">
        {profile.notes.map((n) => {
          const expired = Boolean(n.expiresOn && n.expiresOn < today);
          return editing?.id === n.id ? (
            <li key={n.id}>
              <NoteForm value={editing!} onChange={setEditing} onSave={() => save(editing!)} onCancel={() => setEditing(null)} />
            </li>
          ) : (
            <li key={n.id} className={expired ? "expired" : ""}>
              <span className="note-text">{n.text}</span>
              <span className={`status-pill ${expired ? "cancelled" : n.expiresOn ? "active" : "done"}`}>
                {expired ? `Hết hạn ${fmtDay(n.expiresOn!)}` : n.expiresOn ? `Đến hết ${fmtDay(n.expiresOn)}` : "Không hạn"}
              </span>
              <button className="link small" onClick={() => setEditing(n)}>
                {expired ? "Gia hạn" : "Sửa"}
              </button>
              <button
                className="link small danger"
                onClick={async () => {
                  await api(`/api/profiles/${profile.id}/notes/${n.id}`, { method: "DELETE" });
                  onChanged();
                }}
              >
                Xoá
              </button>
            </li>
          );
        })}
      </ul>
      <NoteForm value={form} onChange={setForm} onSave={() => save(form)} />
      {message && <p className="muted small">{message}</p>}
    </Layer>
  );
}

function NoteForm({ value, onChange, onSave, onCancel }: { value: TimelyNote; onChange: (n: TimelyNote) => void; onSave: () => void; onCancel?: () => void }) {
  return (
    <div className="note-form">
      <input className="grow" value={value.text} onChange={(e) => onChange({ ...value, text: e.target.value })} placeholder="VD: Giảm 20% khoá Sales Bứt Phá cho 30 người đăng ký đầu" />
      <label className="inline">
        Hết hạn
        <input type="date" value={value.expiresOn ?? ""} onChange={(e) => onChange({ ...value, expiresOn: e.target.value || null })} />
      </label>
      <button className="small-btn" onClick={onSave} disabled={!value.text.trim()}>
        {value.id ? "Lưu" : "+ Thêm"}
      </button>
      {onCancel && (
        <button className="link small" onClick={onCancel}>
          Huỷ
        </button>
      )}
    </div>
  );
}

/* ---------- Chat thử & tối ưu ---------- */
type Msg = { role: "user" | "assistant"; content: string; proposal?: Identity | null; notes?: TimelyNote[]; faqs?: Faq[] };

function useChat(endpoint: string, identity: Identity, onNeedEngine: () => void) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; hint?: string; noEngine?: boolean } | null>(null);
  const send = async (text: string) => {
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next);
    setError(null);
    setBusy(true);
    try {
      const r = await api<{ reply?: string; message?: string; proposal?: Identity | null; notes?: TimelyNote[]; faqs?: Faq[] }>(endpoint, {
        body: { messages: next.map(({ role, content }) => ({ role, content })), identity },
      });
      setMessages([...next, { role: "assistant", content: r.reply ?? r.message ?? "", proposal: r.proposal ?? null, notes: r.notes, faqs: r.faqs }]);
    } catch (err) {
      const e = err as ApiError;
      setError({ text: e.message, hint: e.hint, noEngine: /mô hình/.test(e.message) });
    } finally {
      setBusy(false);
    }
  };
  return { messages, setMessages, busy, error, send, onNeedEngine };
}

function ChatBox({ chat, placeholder, empty, renderExtra }: { chat: ReturnType<typeof useChat>; placeholder: string; empty: string; renderExtra?: (m: Msg) => ReactNode }) {
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [chat.messages, chat.busy]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!input.trim() || chat.busy) return;
    chat.send(input.trim());
    setInput("");
  };
  return (
    <div className="chat">
      <div className="row between">
        <span className="muted small">{chat.messages.length ? "" : empty}</span>
        {chat.messages.length > 0 && (
          <button className="link small" onClick={() => chat.setMessages([])}>
            Làm lại từ đầu
          </button>
        )}
      </div>
      <div className="messages">
        {chat.messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.content}
            {renderExtra?.(m)}
          </div>
        ))}
        {chat.busy && <div className="bubble assistant muted">Đang soạn…</div>}
        <div ref={endRef} />
      </div>
      {chat.error && (
        <div className="notice bad">
          {chat.error.text}
          {chat.error.hint && <div className="small">{chat.error.hint}</div>}
          {chat.error.noEngine && (
            <button className="link" onClick={chat.onNeedEngine}>
              Đi tới Mô hình AI
            </button>
          )}
        </div>
      )}
      <form className="composer" onSubmit={submit}>
        <textarea
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) submit(e);
          }}
          placeholder={placeholder}
        />
        <button className="primary" disabled={chat.busy || !input.trim()}>
          Gửi
        </button>
      </form>
    </div>
  );
}

function TestChat({ profileId, identity, onNeedEngine }: { profileId: number; identity: Identity; onNeedEngine: () => void }) {
  const chat = useChat(`/api/profiles/${profileId}/chat`, identity, onNeedEngine);
  return (
    <ChatBox
      chat={chat}
      placeholder="Nhắn như một khách hàng…"
      empty="Nhắn thử như khách. Trợ lý dùng đúng hướng dẫn thật (tầng 0–3), tầng 1 lấy bản đang soạn."
    />
  );
}

function OptimizeChat({
  profileId,
  identity,
  onApply,
  onAdded,
  onNeedEngine,
}: {
  profileId: number;
  identity: Identity;
  onApply: (i: Identity) => void;
  onAdded: () => void;
  onNeedEngine: () => void;
}) {
  const chat = useChat(`/api/profiles/${profileId}/optimize`, identity, onNeedEngine);
  const [shown, setShown] = useState<number | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const add = async (key: string, path: string, body: object) => {
    await api(path, { body });
    setAdded((s) => new Set(s).add(key));
    onAdded();
  };
  return (
    <ChatBox
      chat={chat}
      placeholder='VD: "Trợ lý trả lời cụt quá", "khuyến mãi tháng 12 giảm 15%", hoặc dán đoạn chat bị trả lời sai…'
      empty="Kể cho AI điều bạn chưa ưng hoặc thông tin mới. AI sẽ đặt vào đúng tầng: tầng 1 (danh tính), tầng 2 (hỏi đáp) hay tầng 3 (thời điểm)."
      renderExtra={(m) => {
        const idx = chat.messages.indexOf(m);
        if (!m.proposal && !m.notes?.length && !m.faqs?.length) return null;
        return (
          <div className="proposal">
            {m.proposal && (
              <>
                <div className="row">
                  <i className="lay lay1">1</i>
                  <button className="primary small-btn" onClick={() => onApply(m.proposal!)}>
                    Áp dụng vào tầng 1
                  </button>
                  <button className="link small" onClick={() => setShown(shown === idx ? null : idx)}>
                    {shown === idx ? "Ẩn" : "Xem các ô"}
                  </button>
                </div>
                {shown === idx && (
                  <div className="doc-text">
                    {IDENTITY_FIELDS.filter((f) => m.proposal![f.key]).map((f) => (
                      <div key={f.key}>
                        <b>{f.title}</b>
                        <div style={{ whiteSpace: "pre-wrap" }}>{m.proposal![f.key]}</div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
            {m.notes?.map((n, i) => {
              const key = `${idx}-n${i}`;
              return (
                <div key={key} className="suggest">
                  <i className="lay lay3">3</i>
                  <span>
                    {n.text}
                    {n.expiresOn && <span className="muted"> · đến hết {fmtDay(n.expiresOn)}</span>}
                  </span>
                  <button className="small-btn" disabled={added.has(key)} onClick={() => add(key, `/api/profiles/${profileId}/notes`, n)}>
                    {added.has(key) ? "Đã thêm" : "Thêm vào tầng 3"}
                  </button>
                </div>
              );
            })}
            {m.faqs?.map((f, i) => {
              const key = `${idx}-f${i}`;
              return (
                <div key={key} className="suggest">
                  <i className="lay lay2">2</i>
                  <span>
                    <b>Hỏi:</b> {f.question}
                    <br />
                    <b>Đáp:</b> {f.answer}
                  </span>
                  <button className="small-btn" disabled={added.has(key)} onClick={() => add(key, `/api/profiles/${profileId}/faqs`, f)}>
                    {added.has(key) ? "Đã thêm" : "Thêm vào tầng 2"}
                  </button>
                </div>
              );
            })}
          </div>
        );
      }}
    />
  );
}

function CopyDialog({ profiles, accounts, onClose }: { profiles: Profile[]; accounts: Account[]; onClose: () => void }) {
  const [ids, setIds] = useState<number[]>(profiles.map((p) => p.id));
  const [to, setTo] = useState<number>(accounts[0]?.id ?? 0);
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = await api<{ created: number; updated: number }>("/api/profiles/copy", { body: { profileIds: ids, toAccountId: to } });
      setResult(`Xong: tạo mới ${r.created}, cập nhật ${r.updated} tính cách (kèm đủ 3 tầng).`);
    } catch (err) {
      setResult((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Sao chép tính cách sang tài khoản khác" onClose={onClose}>
      <p className="muted small">
        Sao chép cài đặt, nhãn, tầng 1 (danh tính), tầng 2 (tài liệu, hỏi đáp) và tầng 3 (thông tin thời điểm). Ở tài khoản nhận, tính cách cùng nhãn sẽ
        được ghi đè; còn lại tạo mới.
      </p>
      <div className="stack-sm">
        {profiles.map((p) => (
          <label key={p.id} className="check">
            <input type="checkbox" checked={ids.includes(p.id)} onChange={(e) => setIds((l) => (e.target.checked ? [...l, p.id] : l.filter((x) => x !== p.id)))} />
            {p.name} {p.tag && <span className="muted small">🏷 {p.tag}</span>}
          </label>
        ))}
      </div>
      <label>
        Sang tài khoản
        <select value={to} onChange={(e) => setTo(Number(e.target.value))}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <div className="row">
        <button className="primary" onClick={run} disabled={busy || !ids.length || !to}>
          {busy ? "Đang sao chép…" : `Sao chép ${ids.length} tính cách`}
        </button>
        {result && <span className="small">{result}</span>}
      </div>
    </Modal>
  );
}

/** Chọn nhãn Zalo có sẵn, hoặc gõ tên nhãn mới (được tạo trong Zalo khi gắn lần đầu). */
function TagPicker({ value, labels, connected, onChange }: { value: string; labels: string[]; connected: boolean; onChange: (v: string) => void }) {
  const known = labels.some((l) => l.toLocaleLowerCase("vi") === value.trim().toLocaleLowerCase("vi"));
  const [custom, setCustom] = useState(!connected || (Boolean(value) && !known));
  return (
    <label>
      Nhãn Zalo kích hoạt
      {custom ? (
        <span className="row">
          <input className="grow" value={value} onChange={(e) => onChange(e.target.value)} placeholder="VD: Bot CSKH" />
          {connected && labels.length > 0 && (
            <button type="button" className="link small" onClick={() => setCustom(false)}>
              Chọn nhãn có sẵn
            </button>
          )}
        </span>
      ) : (
        <select
          value={known ? labels.find((l) => l.toLocaleLowerCase("vi") === value.trim().toLocaleLowerCase("vi")) : ""}
          onChange={(e) => {
            if (e.target.value === "__new") {
              setCustom(true);
              onChange("");
            } else onChange(e.target.value);
          }}
        >
          <option value="">— Chọn nhãn trong Zalo —</option>
          {labels.map((l) => (
            <option key={l} value={l}>
              🏷 {l}
            </option>
          ))}
          <option value="__new">+ Tạo nhãn mới…</option>
        </select>
      )}
      {!connected && <span className="muted small">Zalo chưa kết nối nên chưa đọc được danh sách nhãn — gõ đúng tên nhãn.</span>}
    </label>
  );
}
