import { useEffect, useState } from "react";
import { api } from "../api";

/**
 * Từ gọi trợ lý trong nhóm (VD "admin ơi"), tính như tag; dùng chung cho mọi nhóm của nick đang mở.
 * Nằm ở trang Nhóm Zalo (cài đặt chung cho mọi nhóm), không ở cột thông tin từng hội thoại.
 */
export function CallWordsCard() {
  const [words, setWords] = useState<string[] | null>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ words: string[] }>("/api/zalo/call-words")
      .then((r) => setWords(r.words))
      .catch(() => setWords([]));
  }, []);
  if (words === null) return null;
  const save = async () => {
    setError("");
    try {
      const list = (edit ?? "").split(/[,\n]/).map((w) => w.trim()).filter(Boolean);
      const r = await api<{ words: string[] }>("/api/zalo/call-words", { method: "PUT", body: { words: list } });
      setWords(r.words);
      setEdit(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="card stack-sm">
      <div className="row between">
        <strong>Cách gọi trợ lý trong nhóm</strong>
        {edit === null && (
          <button type="button" className="link small" onClick={() => setEdit(words.join(", "))}>
            Sửa từ gọi
          </button>
        )}
      </div>
      <p className="muted small">
        Trợ lý trả lời trong nhóm khi có người tag nick này, trả lời vào tin của trợ lý, hoặc gọi bằng một trong các từ dưới. Người vừa được trả lời hỏi
        tiếp trong 10 phút thì không cần gọi lại. Muốn trợ lý tự trả lời câu hỏi không cần gọi, bật ở cột thông tin của nhóm trong Hộp thư.
      </p>
      {edit === null ? (
        <div className="chips">
          {words.length ? words.map((w) => <span key={w} className="chip">{w}</span>) : <span className="muted small">Chưa có từ gọi, chỉ tag mới gọi được.</span>}
        </div>
      ) : (
        <div className="stack-sm">
          <input value={edit} onChange={(e) => setEdit(e.target.value)} placeholder="admin ơi, ad ơi, trợ lý ơi" autoFocus aria-label="Từ gọi trợ lý" />
          <span className="muted small">Cách nhau bằng dấu phẩy. Có dấu hay không dấu đều được. Dùng cho mọi nhóm của nick đang chọn.</span>
          <div className="row">
            <button type="button" className="small-btn primary" onClick={save}>
              Lưu
            </button>
            <button type="button" className="link small" onClick={() => setEdit(null)}>
              Huỷ
            </button>
          </div>
        </div>
      )}
      {error && <div className="notice bad small">{error}</div>}
    </div>
  );
}
