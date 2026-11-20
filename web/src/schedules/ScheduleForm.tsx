import { useEffect, useMemo, useRef, useState } from "react";
import { api, uploadImage } from "../api";
import { type Recurrence, type RecurrenceType, type Schedule, type Target, URGENCY_LABEL, type Urgency, vnToday } from "./types";

const WEEKDAYS: { v: number; label: string }[] = [
  { v: 1, label: "T2" },
  { v: 2, label: "T3" },
  { v: 3, label: "T4" },
  { v: 4, label: "T5" },
  { v: 5, label: "T6" },
  { v: 6, label: "T7" },
  { v: 0, label: "CN" },
];
const MAX_IMAGES = 10;

interface Candidate extends Target {
  hint: string;
}

function defaultTime() {
  const d = new Date(Date.now() + 7 * 3_600_000 + 60 * 60_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:00`;
}

/** Form tạo / sửa lịch gửi tin. */
export function ScheduleForm({
  initial,
  defaultTarget,
  defaultTargets,
  onClose,
  onSaved,
}: {
  initial?: Schedule;
  defaultTarget?: Target;
  /** Lên lịch hàng loạt từ các hội thoại đã tích chọn. */
  defaultTargets?: Target[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [text, setText] = useState(initial?.text ?? "");
  const [images, setImages] = useState<{ id: number; url: string }[]>(initial?.images ?? []);
  const [targets, setTargets] = useState<Target[]>(initial?.targets ?? defaultTargets ?? (defaultTarget ? [defaultTarget] : []));
  const [rec, setRec] = useState<Recurrence>({
    type: "once",
    date: vnToday(),
    time: defaultTime(),
    weekdays: [1, 3, 5],
    monthDay: 1,
    ...initial?.recurrence,
  });
  const [hasEnd, setHasEnd] = useState(Boolean(initial?.recurrence.endDate));
  const [mentionAll, setMentionAll] = useState(initial?.mentionAll ?? false);
  const [urgency, setUrgency] = useState<Urgency>(initial?.urgency ?? 0);
  const groupCount = targets.filter((t) => t.threadType === "group").length;
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [search, setSearch] = useState("");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "ai" | "upload">("");
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState<{ name: string; text: string } | null>(null);

  // Xem trước tin cho người nhận đầu tiên khi tin có biến {xưng hô}, {tên}.
  const firstTarget = targets[0];
  useEffect(() => {
    if (!firstTarget || !hasVars(text)) return setPreview(null);
    let alive = true;
    const t = setTimeout(async () => {
      let gender = "";
      if (firstTarget.threadType === "user") {
        const r = await api<{ contacts: Record<string, { gender: string }> }>(`/api/contacts?ids=${encodeURIComponent(firstTarget.threadId)}`).catch(() => null);
        gender = r?.contacts[firstTarget.threadId]?.gender ?? "";
      }
      if (alive) setPreview({ name: firstTarget.name, text: renderVars(text, firstTarget.threadType === "group", firstTarget.name, gender) });
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [text, firstTarget?.threadId, firstTarget?.name, firstTarget?.threadType]); // eslint-disable-line react-hooks/exhaustive-deps

  const insertVar = (v: string) => {
    const el = textRef.current;
    const at = el ? el.selectionStart : text.length;
    const end = el ? el.selectionEnd : text.length;
    setText(text.slice(0, at) + v + text.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + v.length, at + v.length);
    });
  };

  useEffect(() => {
    // Ứng viên người nhận: hội thoại trong hộp thư + toàn bộ nhóm Zalo (nếu đang kết nối).
    const list = new Map<string, Candidate>();
    api<{ conversations: { thread_id: string; thread_type: "user" | "group"; name: string }[] }>("/api/zalo/conversations")
      .then((r) => {
        for (const c of r.conversations) {
          list.set(c.thread_id, { threadId: c.thread_id, threadType: c.thread_type, name: c.name || c.thread_id, hint: c.thread_type === "group" ? "Nhóm" : "Chat riêng" });
        }
        setCandidates([...list.values()]);
      })
      .catch(() => undefined);
    api<{ groups: { id: string; name: string; memberCount: number }[] }>("/api/zalo/groups")
      .then((r) => {
        for (const g of r.groups) {
          if (!list.has(g.id)) list.set(g.id, { threadId: g.id, threadType: "group", name: g.name, hint: `Nhóm · ${g.memberCount} thành viên` });
        }
        setCandidates([...list.values()]);
      })
      .catch(() => undefined);
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLocaleLowerCase("vi");
    const chosen = new Set(targets.map((t) => t.threadId));
    return candidates
      .filter((c) => !chosen.has(c.threadId) && (!q || c.name.toLocaleLowerCase("vi").includes(q)))
      .slice(0, 8);
  }, [candidates, search, targets]);

  const setR = (patch: Partial<Recurrence>) => setRec((r) => ({ ...r, ...patch }));
  const hour = Number(rec.time.split(":")[0]);
  const quiet = hour >= 22 || hour < 7;

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setError("");
    setBusy("upload");
    try {
      for (const f of Array.from(files)) {
        if (images.length >= MAX_IMAGES) throw new Error(`Tối đa ${MAX_IMAGES} ảnh`);
        const m = await uploadImage(f);
        setImages((list) => (list.length < MAX_IMAGES ? [...list, m] : list));
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  };

  const aiDraft = async () => {
    setError("");
    setBusy("ai");
    try {
      const r = await api<{ text: string }>("/api/schedules/ai-draft", { body: { brief } });
      setText(r.text);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  };

  const save = async () => {
    setError("");
    setBusy("save");
    const recurrence: Recurrence = {
      type: rec.type,
      date: rec.date,
      time: rec.time,
      ...(rec.type === "weekly" ? { weekdays: rec.weekdays } : {}),
      ...(rec.type === "monthly" ? { monthDay: Number(rec.monthDay) } : {}),
      ...(rec.type !== "once" && hasEnd && rec.endDate ? { endDate: rec.endDate } : {}),
    };
    const body = { title, text, imageIds: images.map((i) => i.id), targets, recurrence, mentionAll: mentionAll && groupCount > 0, urgency };
    try {
      if (initial) await api(`/api/schedules/${initial.id}`, { method: "PUT", body });
      else await api("/api/schedules", { body });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="modal" onClick={onClose}>
      <div className="card modal-body schedule-form" onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <strong>{initial ? "Sửa lịch gửi" : "Lên lịch gửi tin"}</strong>
          <button className="link" onClick={onClose}>
            Đóng
          </button>
        </div>

        <div className="form-scroll stack">
          <label>
            Tên lịch <span className="muted small">(tuỳ chọn, chỉ bạn thấy)</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="VD: Nhắc lịch học tối thứ 3" />
          </label>

          <div className="stack-sm">
            <span className="field-label">Gửi tới</span>
            <div className="chips">
              {targets.map((t) => (
                <span key={t.threadId} className="chip">
                  {t.threadType === "group" ? "👥 " : "👤 "}
                  {t.name || t.threadId}
                  <button aria-label="Bỏ" onClick={() => setTargets((l) => l.filter((x) => x.threadId !== t.threadId))}>
                    ×
                  </button>
                </span>
              ))}
            </div>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Tìm nhóm hoặc người để thêm…" />
            {search && (
              <ul className="picker">
                {filtered.length === 0 && <li className="muted small">Không tìm thấy</li>}
                {filtered.map((c) => (
                  <li key={c.threadId}>
                    <button
                      onClick={() => {
                        setTargets((l) => [...l, { threadId: c.threadId, threadType: c.threadType, name: c.name }]);
                        setSearch("");
                      }}
                    >
                      {c.threadType === "group" ? "👥" : "👤"} {c.name} <span className="muted small">{c.hint}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="stack-sm">
            <span className="field-label">Nội dung</span>
            <textarea ref={textRef} rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="Nội dung tin nhắn. VD: Chào {xưng hô} {tên}, tối nay 20h lớp mình học nhé!" />
            <div className="sched-vars">
              <span className="muted">Chèn:</span>
              {VARS.map(([v, hint]) => (
                <button key={v} type="button" className="sched-var" title={hint} onClick={() => insertVar(v)}>
                  {v}
                </button>
              ))}
              <span className="muted small">Mỗi người nhận một tin riêng: anh / chị / bạn theo giới tính hồ sơ Zalo, nhóm thì là "mọi người".</span>
            </div>
            {preview && (
              <div className="sched-preview">
                <span className="muted small">Xem trước cho {preview.name || "người nhận đầu tiên"}:</span>
                <div>{preview.text}</div>
              </div>
            )}
            <div className="row">
              <input
                className="grow"
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                placeholder="Nhờ AI viết: VD nhắc học viên buổi học tối nay 20h, mang theo workbook"
              />
              <button onClick={aiDraft} disabled={busy !== "" || !brief.trim()}>
                {busy === "ai" ? "Đang viết…" : "AI viết giúp"}
              </button>
            </div>
            {busy !== "ai" && text && brief && <span className="muted small">AI chỉ viết nháp vào ô trên — bạn sửa thoải mái trước khi lưu.</span>}
          </div>

          <div className="stack-sm">
            <span className="field-label">
              Ảnh <span className="muted small">({images.length}/{MAX_IMAGES}, gửi trước phần chữ)</span>
            </span>
            <div className="thumbs">
              {images.map((img) => (
                <div key={img.id} className="thumb">
                  <img src={img.url} alt="" />
                  <button aria-label="Bỏ ảnh" onClick={() => setImages((l) => l.filter((x) => x.id !== img.id))}>
                    ×
                  </button>
                </div>
              ))}
              {images.length < MAX_IMAGES && (
                <button className="thumb add" onClick={() => fileRef.current?.click()} disabled={busy === "upload"}>
                  {busy === "upload" ? "…" : "+ Ảnh"}
                </button>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".jpg,.jpeg,.png,.webp"
              multiple
              hidden
              onChange={(e) => {
                upload(e.target.files);
                e.target.value = "";
              }}
            />
          </div>

          <div className="stack-sm">
            <span className="field-label">Cách gửi</span>
            <label className="inline check">
              <input type="checkbox" checked={mentionAll && groupCount > 0} disabled={groupCount === 0} onChange={(e) => setMentionAll(e.target.checked)} /> Tag tất cả
              mọi người trong nhóm <span className="muted small">(thêm @All ở đầu tin, cả nhóm nhận thông báo)</span>
            </label>
            {groupCount === 0 ? (
              <span className="muted small">Chỉ dùng được khi gửi vào nhóm Zalo.</span>
            ) : (
              groupCount < targets.length && mentionAll && <span className="muted small">Người nhận chat riêng vẫn nhận tin bình thường, không có @All.</span>
            )}
            <div className="row">
              <span className="small">Mức độ tin</span>
              <div className="seg">
                {([0, 1, 2] as Urgency[]).map((u) => (
                  <button key={u} type="button" className={urgency === u ? "active" : ""} onClick={() => setUrgency(u)}>
                    {URGENCY_LABEL[u]}
                  </button>
                ))}
              </div>
            </div>
            {urgency > 0 && (
              <span className="muted small">
                Zalo gắn nhãn <b>{URGENCY_LABEL[urgency]}</b> lên tin để người nhận chú ý. Chỉ dùng cho tin thật sự cần, dùng nhiều người nhận sẽ quen và bỏ qua.
              </span>
            )}
          </div>

          <div className="stack-sm">
            <span className="field-label">Thời gian (giờ Việt Nam)</span>
            <div className="seg">
              {(
                [
                  ["once", "Một lần"],
                  ["daily", "Hằng ngày"],
                  ["weekly", "Theo thứ"],
                  ["monthly", "Hằng tháng"],
                ] as [RecurrenceType, string][]
              ).map(([v, label]) => (
                <button key={v} className={rec.type === v ? "active" : ""} onClick={() => setR({ type: v })}>
                  {label}
                </button>
              ))}
            </div>
            <div className="row">
              <label className="inline">
                {rec.type === "once" ? "Ngày" : "Bắt đầu từ"}
                <input type="date" value={rec.date} onChange={(e) => setR({ date: e.target.value })} />
              </label>
              <label className="inline">
                Giờ
                <input type="time" value={rec.time} onChange={(e) => setR({ time: e.target.value })} />
              </label>
              {rec.type === "monthly" && (
                <label className="inline">
                  Ngày trong tháng
                  <input type="number" min={1} max={31} value={rec.monthDay ?? 1} onChange={(e) => setR({ monthDay: Number(e.target.value) })} />
                </label>
              )}
            </div>
            {rec.type === "weekly" && (
              <div className="seg">
                {WEEKDAYS.map((w) => {
                  const on = rec.weekdays?.includes(w.v);
                  return (
                    <button
                      key={w.v}
                      className={on ? "active" : ""}
                      onClick={() =>
                        setRec((r) => {
                          const cur = r.weekdays ?? [];
                          return { ...r, weekdays: cur.includes(w.v) ? cur.filter((x) => x !== w.v) : [...cur, w.v] };
                        })
                      }
                    >
                      {w.label}
                    </button>
                  );
                })}
              </div>
            )}
            {rec.type === "monthly" && (rec.monthDay ?? 1) > 28 && (
              <span className="muted small">Tháng không có ngày {rec.monthDay} thì gửi vào ngày cuối tháng.</span>
            )}
            {rec.type !== "once" && (
              <div className="row">
                <label className="inline check">
                  <input type="checkbox" checked={hasEnd} onChange={(e) => setHasEnd(e.target.checked)} /> Có ngày kết thúc
                </label>
                {hasEnd && <input type="date" value={rec.endDate ?? ""} onChange={(e) => setR({ endDate: e.target.value })} />}
              </div>
            )}
            {quiet && (
              <div className="notice warn small">
                Giờ gửi nằm trong khoảng 22h–7h. Tin vẫn đi đúng giờ, hãy chắc người nhận không phiền.
              </div>
            )}
          </div>
        </div>

        {error && <div className="notice bad">{error}</div>}
        <div className="row">
          <button className="primary" onClick={save} disabled={busy !== ""}>
            {busy === "save" ? "Đang lưu…" : initial ? "Lưu thay đổi" : "Lên lịch"}
          </button>
          <button className="link" onClick={onClose}>
            Huỷ bỏ
          </button>
          <span className="muted small push">Nếu Zalo mất kết nối lúc đến giờ, tin được gửi bù trong 30 phút; trễ hơn sẽ báo "Lỡ giờ".</span>
        </div>
      </div>
    </div>
  );
}

const VARS: [string, string][] = [
  ["{xưng hô}", "anh / chị / bạn theo giới tính (nhóm: mọi người)"],
  ["{Xưng hô}", "Như trên, viết hoa chữ đầu — dùng ở đầu câu"],
  ["{tên}", "Tên người nhận (nhóm: tên nhóm)"],
];
const VAR_RE = /\{(xưng hô|Xưng hô|xung_ho|Xung_ho|tên|ten)\}/g;
const hasVars = (t: string) => new RegExp(VAR_RE.source).test(t);
/** Giống src/scheduler/render.ts (máy chủ điền thật lúc gửi); ở đây chỉ để xem trước. */
function renderVars(t: string, isGroup: boolean, name: string, gender: string): string {
  const x = isGroup ? "mọi người" : gender === "nam" ? "anh" : gender === "nu" ? "chị" : "bạn";
  const n = name.trim() || (isGroup ? "nhóm" : x);
  return t.replace(VAR_RE, (_, k: string) => (k === "tên" || k === "ten" ? n : k[0] === "X" ? x[0]!.toLocaleUpperCase("vi") + x.slice(1) : x));
}
