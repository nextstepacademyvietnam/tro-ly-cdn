export type RecurrenceType = "once" | "daily" | "weekly" | "monthly";
export type ScheduleStatus = "active" | "paused" | "cancelled" | "done";
export type RunStatus = "sent" | "failed" | "missed";

export interface Recurrence {
  type: RecurrenceType;
  date: string;
  time: string;
  weekdays?: number[];
  monthDay?: number;
  endDate?: string;
}

export interface Target {
  threadId: string;
  threadType: "user" | "group";
  name: string;
}

export interface ScheduleRun {
  id: number;
  scheduleId: number;
  threadId: string;
  plannedAt: number;
  status: RunStatus;
  error: string;
  doneAt: number;
  manual: boolean;
}

export interface Schedule {
  id: number;
  title: string;
  text: string;
  imageIds: number[];
  images: { id: number; url: string }[];
  targets: Target[];
  recurrence: Recurrence;
  status: ScheduleStatus;
  nextRunAt: number | null;
  summary: string;
  quietHours: boolean;
  stats: { sent: number; failed: number; missed: number };
  lastRuns: ScheduleRun[];
  updatedAt: number;
}

export const STATUS_LABEL: Record<ScheduleStatus, string> = {
  active: "Chờ gửi",
  paused: "Tạm dừng",
  cancelled: "Đã huỷ",
  done: "Hoàn tất",
};

export const RUN_LABEL: Record<RunStatus, string> = {
  sent: "Đã gửi",
  failed: "Lỗi",
  missed: "Lỡ giờ",
};

export const fmtDateTime = (ms: number) =>
  new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(ms);

/** Hôm nay theo giờ Việt Nam, YYYY-MM-DD. */
export const vnToday = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
