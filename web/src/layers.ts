/** Các ô của tầng 1 — giữ khớp với src/core/promptLayers.ts (IDENTITY_FIELDS). */
export interface Identity {
  who: string;
  goal: string;
  voice: string;
  can: string;
  cannot: string;
  handoff: string;
  notes: string;
}

export const EMPTY_IDENTITY: Identity = { who: "", goal: "", voice: "", can: "", cannot: "", handoff: "", notes: "" };

export const IDENTITY_FIELDS: { key: keyof Identity; title: string; hint: string; example: string; rows: number }[] = [
  {
    key: "who",
    title: "Trợ lý là ai, thay mặt ai",
    hint: "Tên trợ lý, làm việc cho ai, doanh nghiệp làm gì — 1–3 câu.",
    example: "VD: Bạn là Mai, trợ lý của chị Thảo ở Next Step Group — đơn vị đào tạo kỹ năng bán hàng cho chủ doanh nghiệp nhỏ.",
    rows: 2,
  },
  {
    key: "goal",
    title: "Mục tiêu khi trò chuyện",
    hint: "Sau mỗi cuộc trò chuyện, trợ lý cần đạt được điều gì.",
    example: "VD: Giúp khách hiểu khoá học có hợp với họ không, trả lời đúng thông tin, và hẹn lịch gọi tư vấn khi khách quan tâm.",
    rows: 2,
  },
  {
    key: "voice",
    title: "Giọng và xưng hô",
    hint: "Xưng gì, gọi khách thế nào, thân mật hay trang trọng, có dùng biểu tượng cảm xúc không.",
    example: 'VD: Xưng em, gọi anh/chị. Thân thiện, lễ phép, mở đầu bằng "Dạ". Tối đa 1 biểu tượng cảm xúc mỗi tin.',
    rows: 2,
  },
  {
    key: "can",
    title: "Được làm",
    hint: "Việc trợ lý được tự làm — mỗi dòng một việc.",
    example: "VD:\n- Giới thiệu khoá học theo tài liệu\n- Gửi lịch khai giảng đang mở\n- Hỏi nhu cầu, quy mô doanh nghiệp của khách",
    rows: 3,
  },
  {
    key: "cannot",
    title: "Không được làm",
    hint: "Điều riêng của doanh nghiệp bạn mà trợ lý không được nói/làm (luật an toàn chung đã có ở tầng 0).",
    example: "VD:\n- Không so sánh với đơn vị khác\n- Không hứa cam kết doanh số",
    rows: 3,
  },
  {
    key: "handoff",
    title: "Khi nào chuyển cho chủ (bổ sung)",
    hint: "Trường hợp riêng cần người thật, ngoài các trường hợp tầng 0 đã có.",
    example: "VD:\n- Khách muốn đăng ký từ 3 người trở lên\n- Khách là doanh nghiệp muốn đào tạo nội bộ",
    rows: 2,
  },
  {
    key: "notes",
    title: "Ghi chú thêm",
    hint: "Điều khác cần dặn mà không thuộc ô nào ở trên.",
    example: "VD: Khách nhắn sau 21h thì trả lời ngắn và hẹn sáng hôm sau chị Thảo liên hệ.",
    rows: 3,
  },
];

export interface Faq {
  id?: number;
  question: string;
  answer: string;
  updatedAt?: number;
}

export interface TimelyNote {
  id?: number;
  text: string;
  expiresOn: string | null;
  updatedAt?: number;
}

export const identityLength = (i: Identity) => IDENTITY_FIELDS.reduce((n, f) => n + (i[f.key]?.length ?? 0), 0);
export const fmtDay = (ymd: string) => ymd.split("-").reverse().join("/");
export const fmtDate = (ms: number) => new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" }).format(ms);
export const daysAgo = (ms: number) => Math.floor((Date.now() - ms) / 86_400_000);
