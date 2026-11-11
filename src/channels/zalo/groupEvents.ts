/**
 * Chuẩn hoá sự kiện nhóm của zca-js ("group_event") thành dạng gọn app dùng.
 * Chỉ giữ các sự kiện thay đổi thành viên; các loại khác (ghim, bảng tin, nhắc hẹn…) bỏ qua.
 */

export type GroupChangeKind = "join" | "leave" | "remove" | "block";

export interface GroupChange {
  kind: GroupChangeKind;
  groupId: string;
  groupName: string;
  /** Những người được thêm / rời / bị mời ra. */
  members: { id: string; name: string }[];
  /** Người thực hiện: ai thêm vào, ai mời ra. Rỗng hoặc trùng thành viên khi tự vào / tự rời. */
  actorId: string;
  /** "link" = tự vào (link nhóm, được duyệt yêu cầu); "added" = được một thành viên thêm vào. */
  via: "" | "link" | "added";
  at: number;
  /** Nick trợ lý là người thực hiện (VD: nick tự mời người khác ra). */
  isSelf: boolean;
}

const KIND: Record<string, GroupChangeKind> = {
  join: "join",
  leave: "leave",
  remove_member: "remove",
  block_member: "block",
};

export function normalizeGroupEvent(raw: unknown, now = Date.now()): GroupChange | null {
  const e = raw as { type?: string; data?: Record<string, unknown>; threadId?: string; isSelf?: boolean } | null;
  const kind = e?.type ? KIND[e.type] : undefined;
  if (!kind || !e?.data) return null;
  const d = e.data as {
    groupId?: unknown;
    groupName?: unknown;
    sourceId?: unknown;
    creatorId?: unknown;
    updateMembers?: { id?: unknown; dName?: unknown }[];
    time?: unknown;
  };
  const groupId = String(d.groupId ?? e.threadId ?? "");
  if (!groupId) return null;
  const members = (Array.isArray(d.updateMembers) ? d.updateMembers : [])
    .map((m) => ({ id: String(m?.id ?? ""), name: String(m?.dName ?? "").trim() }))
    .filter((m) => m.id);
  if (members.length === 0) return null;
  const actorId = String(d.sourceId ?? "");
  const at = Number(d.time);
  return {
    kind,
    groupId,
    groupName: String(d.groupName ?? ""),
    members,
    actorId,
    via: kind !== "join" ? "" : actorId && !members.some((m) => m.id === actorId) ? "added" : "link",
    at: Number.isFinite(at) && at > 1e12 ? at : now,
    isSelf: Boolean(e.isSelf),
  };
}

/** Danh sách id thành viên từ getGroupInfo: memVerList có dạng "uid_phiênbản". */
export function memberIdsFromInfo(info: { memVerList?: unknown; memberIds?: unknown } | undefined): string[] {
  const ver = Array.isArray(info?.memVerList) ? (info!.memVerList as unknown[]) : [];
  const ids = ver.length ? ver.map((v) => String(v).split("_")[0]!) : Array.isArray(info?.memberIds) ? (info!.memberIds as unknown[]).map(String) : [];
  return [...new Set(ids.filter(Boolean))];
}
