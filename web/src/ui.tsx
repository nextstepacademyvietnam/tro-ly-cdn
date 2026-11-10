import { type ReactNode, useEffect, useRef, useState } from "react";
import { Users } from "lucide-react";

/** Lớp nổi gắn vào một nút: bấm ra ngoài hoặc Esc thì đóng. */
export function Popover({
  trigger,
  children,
  align = "start",
  className = "",
  wrapClassName = "pop-wrap",
}: {
  trigger: (p: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "start" | "end";
  className?: string;
  wrapClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className={wrapClassName} ref={ref}>
      {trigger({ open, toggle: () => setOpen((v) => !v) })}
      {open && (
        <div className={`popover ${align === "end" ? "end" : ""} ${className}`} role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** Hai chữ đầu của tên: "Vũ Hiếu - Coach Duy" → "VH". */
export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  return words
    .slice(0, 2)
    .map((w) => w[0]!.toLocaleUpperCase("vi"))
    .join("");
}

export function Avatar({ name, group, small, children }: { name: string; group?: boolean; small?: boolean; children?: ReactNode }) {
  return (
    <span className={small ? "avatar sm" : "avatar"}>
      {group ? <Users aria-hidden /> : initials(name) || "?"}
      {children}
    </span>
  );
}

/** "23 phút", "1 giờ 12 phút", "3 ngày". */
export function waitText(ms: number): string {
  const m = Math.max(1, Math.floor(ms / 60_000));
  if (m < 60) return `${m} phút`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} giờ ${m % 60} phút` : `${h} giờ`;
  return `${Math.floor(h / 24)} ngày`;
}

/** Mức chờ: từ 15 phút "mid", từ 1 giờ "high". */
export function waitLevel(ms: number): "" | "mid" | "high" {
  return ms >= 3_600_000 ? "high" : ms >= 900_000 ? "mid" : "";
}

const hm = new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit" });
const dm = new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit" });
const dmy = new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
/** Giờ trong ngày nếu là hôm nay, ngày/tháng nếu cũ hơn. */
export function shortTime(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString() ? hm.format(d) : dm.format(d);
}
export const fullDate = (ms: number) => (ms ? dmy.format(ms) : "—");
export const timeAndDay = (ms: number) => `${hm.format(ms)} ${dm.format(ms)}`;
