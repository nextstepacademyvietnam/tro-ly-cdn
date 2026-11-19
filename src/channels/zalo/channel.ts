import { EventEmitter } from "node:events";
import { type GroupChange, memberIdsFromInfo, normalizeGroupEvent } from "./groupEvents.js";
import fs from "node:fs";
import path from "node:path";
import { imageSize } from "image-size";
import { Zalo, ThreadType as ZThreadType, LoginQRCallbackEventType, type API, type Credentials } from "zca-js";
import type { Settings } from "../../server/settings.js";
import { type Gender, genderFromZalo } from "../../core/contacts.js";
import {
  type InboundEvent,
  type ThreadType,
  birthdayNotice,
  canonicalizeSelfThread,
  chunked,
  isFriendAcceptanceNotice,
  normalizeMessage,
  publicGroup,
  remainingQuietMs,
  splitLongText,
  withTimeout,
} from "./protocol.js";
import { SendPacer, typingDelayMs } from "./pacing.js";
import { type LabelData, applyLabelChange, hasLabel, labelSummaries } from "./labels.js";

const LABELS_TTL_MS = 60_000;
const TYPING_QUIET_MS = 4_000;
const SEND_TIMEOUT_MS = 20_000;
const MAX_QR_RETRIES = 3;

export type ZaloState = "logged_out" | "waiting_qr" | "scanned" | "connecting" | "connected" | "reconnecting" | "error";

export interface ZaloStatus {
  state: ZaloState;
  /** Ảnh QR dạng data URL khi đang chờ quét. */
  qrImage?: string;
  scannedName?: string;
  ownId?: string;
  ownName?: string;
  error?: string;
  since: number;
}

export interface ZaloChannelEvents {
  status: [ZaloStatus];
  inbound: [InboundEvent, { sentByApp: boolean }];
  typing: [{ threadId: string; senderId: string }];
  birthday: [{ userId: string; displayName: string }];
  /** Thành viên vào / rời / bị mời ra / bị chặn khỏi một nhóm. */
  group: [GroupChange];
}

export interface GroupDetail {
  id: string;
  name: string;
  totalMember: number;
  memberIds: string[];
  adminIds: string[];
  creatorId: string;
}

/**
 * Một tài khoản Zalo cá nhân, đăng nhập bằng QR qua zca-js (API không chính thức).
 * Mỗi tài khoản chỉ được một listener: Zalo Web mở ở nơi khác sẽ đá phiên này ra.
 */
export class ZaloChannel extends EventEmitter<ZaloChannelEvents> {
  private api: API | null = null;
  private status: ZaloStatus = { state: "logged_out", since: Date.now() };
  private readonly sentIds = new Set<string>();
  private readonly typingUntil = new Map<string, number>();
  private readonly groupNames = new Map<string, string>();
  private readonly pacer = new SendPacer();
  private loginAbort: (() => unknown) | null = null;
  private lockFile: string;
  private lockBeat: NodeJS.Timeout | null = null;
  private readonly credentialsKey: string;
  private labelsCache: { at: number; data: unknown } | null = null;
  /** Tự nối lại khi mất kết nối (rớt mạng, máy ngủ): thư viện Zalo chỉ tự thử lại với vài mã đóng của máy chủ. */
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private stopped = false;

  constructor(private readonly settings: Settings, dataDir: string, readonly accountId = 1) {
    super();
    this.lockFile = path.join(dataDir, `zalo-${accountId}.lock`);
    this.credentialsKey = `zalo.credentials.${accountId}`;
  }

  getStatus(): ZaloStatus {
    return this.status;
  }

  private setStatus(patch: Omit<ZaloStatus, "since">) {
    this.status = { ...patch, since: Date.now() };
    this.emit("status", this.status);
  }

  hasCredentials(): boolean {
    return Boolean(this.settings.getSecret<Credentials>(this.credentialsKey));
  }

  /** Khởi động cùng app: có phiên đã lưu thì nối lại. */
  async start(): Promise<void> {
    if (this.hasCredentials()) await this.connect().catch(() => undefined);
  }

  private newClient(): Zalo {
    // zca-js cần kích thước ảnh để gửi ảnh từ file; thiếu hàm này thì mọi tin có ảnh đều lỗi.
    return new Zalo({ selfListen: true, logging: false, checkUpdate: false, imageMetadataGetter: readImageMetadata });
  }

  /** Bắt đầu đăng nhập bằng QR. Ảnh QR xuất hiện trong `getStatus().qrImage`. */
  async loginWithQr(): Promise<void> {
    this.stopListener();
    this.loginAbort?.();
    this.acquireLock();
    let retries = 0;
    this.setStatus({ state: "waiting_qr" });
    const zalo = this.newClient();
    const loginPromise = zalo.loginQR({}, async (event) => {
      switch (event.type) {
        case LoginQRCallbackEventType.QRCodeGenerated: {
          this.loginAbort = event.actions.abort;
          const img = event.data.image;
          this.setStatus({ state: "waiting_qr", qrImage: img.startsWith("data:") ? img : `data:image/png;base64,${img}` });
          break;
        }
        case LoginQRCallbackEventType.QRCodeExpired:
          if (++retries <= MAX_QR_RETRIES) event.actions.retry();
          else {
            event.actions.abort();
            this.setStatus({ state: "logged_out", error: "Mã QR hết hạn. Bấm đăng nhập lại để lấy mã mới." });
          }
          break;
        case LoginQRCallbackEventType.QRCodeScanned:
          this.setStatus({ state: "scanned", scannedName: event.data.display_name });
          break;
        case LoginQRCallbackEventType.QRCodeDeclined:
          this.setStatus({ state: "logged_out", error: "Đăng nhập bị từ chối trên điện thoại." });
          break;
        case LoginQRCallbackEventType.GotLoginInfo:
          this.settings.setSecret(this.credentialsKey, {
            cookie: event.data.cookie,
            imei: event.data.imei,
            userAgent: event.data.userAgent,
          } satisfies Credentials);
          break;
      }
    });

    loginPromise
      .then((api) => this.attach(api))
      .catch((err: Error) => {
        if (this.status.state === "logged_out") return; // đã báo lỗi ở callback
        this.releaseLock();
        this.setStatus({ state: "error", error: `Đăng nhập Zalo thất bại: ${err.message}` });
      })
      .finally(() => (this.loginAbort = null));
  }

  /** Chờ trước lần tự nối lại thứ n: 10 giây, 30 giây, 1, 2 phút, rồi 5 phút một lần. */
  static reconnectDelay(attempt: number): number {
    return [10_000, 30_000, 60_000, 120_000][attempt] ?? 300_000;
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.stopped) return;
    const wait = ZaloChannel.reconnectDelay(this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped || this.api || this.status.state === "logged_out" || this.status.state === "connected") return;
      this.connect().catch(() => {
        // Còn lỗi (mạng chưa có, Zalo chưa nhận): giữ thông báo dễ hiểu và hẹn lần sau.
        if (this.stopped || this.status.state === "logged_out") return;
        const next = Math.round(ZaloChannel.reconnectDelay(this.reconnectAttempt) / 60_000) || 1;
        this.setStatus({ state: "error", error: `Mất kết nối Zalo. App tự thử lại sau ${next} phút, hoặc bấm Kết nối lại.` });
        this.scheduleReconnect();
      });
    }, wait);
    this.reconnectTimer.unref?.();
  }

  private cancelReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  async connect(): Promise<void> {
    this.cancelReconnect();
    this.stopped = false;
    const creds = this.settings.getSecret<Credentials>(this.credentialsKey);
    if (!creds) {
      this.setStatus({ state: "logged_out" });
      return;
    }
    this.acquireLock();
    this.setStatus({ state: "connecting" });
    try {
      await this.attach(await this.newClient().login(creds));
    } catch (err) {
      this.releaseLock();
      this.setStatus({
        state: "error",
        error: `Không nối lại được phiên Zalo (có thể đã đăng xuất trên điện thoại): ${(err as Error).message}. Hãy đăng nhập lại bằng QR.`,
      });
      throw err;
    }
  }

  private async attach(api: API) {
    this.api = api;
    const ownId = String(api.getOwnId());
    let ownName = this.status.scannedName;
    try {
      const info = (await withTimeout(api.fetchAccountInfo(), 8_000)) as { profile?: { displayName?: string; zaloName?: string } };
      ownName = info?.profile?.displayName || info?.profile?.zaloName || ownName;
    } catch {
      /* tên chỉ để hiển thị */
    }

    api.listener.on("message", (raw) => {
      if (birthdayNotice(raw as never)) {
        const notice = birthdayNotice(raw as never)!;
        const type = String((raw as { type?: unknown }).type ?? "");
        if (type !== "1" && raw.threadId !== ownId) this.emit("birthday", { userId: String(raw.threadId), displayName: notice.displayName });
        return;
      }
      if (isFriendAcceptanceNotice(raw as never)) return;
      const event = canonicalizeSelfThread(normalizeMessage(raw as never), ownId);
      if (!event.threadId) return;
      const sentByApp = event.isSelf && this.sentIds.has(event.messageId);
      this.emit("inbound", event, { sentByApp });
    });
    api.listener.on("group_event", (raw) => {
      const change = normalizeGroupEvent(raw);
      if (change) this.emit("group", change);
    });
    api.listener.on("typing", (t) => {
      const threadId = String(t?.threadId ?? "");
      const senderId = String((t as { data?: { uid?: unknown } })?.data?.uid ?? "");
      if (!threadId) return;
      this.typingUntil.set(threadId, Date.now() + TYPING_QUIET_MS);
      this.emit("typing", { threadId, senderId });
    });
    api.listener.on("connected", () => this.setStatus({ state: "connected", ownId, ownName }));
    api.listener.on("disconnected", () => {
      if (this.status.state === "connected") this.setStatus({ state: "reconnecting", ownId, ownName });
    });
    api.listener.on("closed", (code) => {
      this.api = null;
      this.releaseLock();
      if (code === 3000 || code === 3003) {
        this.setStatus({
          state: "error",
          ownId,
          ownName,
          error: "Zalo Web đang được mở ở nơi khác nên phiên của trợ lý bị ngắt. Đóng Zalo Web kia rồi bấm Kết nối lại.",
        });
      } else if (this.status.state !== "logged_out" && !this.stopped) {
        // Rớt mạng / máy ngủ dậy: tự nối lại, không bắt chủ phải bấm. Tin và người vào nhóm trong lúc mất
        // kết nối thì lượt đối chiếu nhóm sau khi nối lại sẽ bắt bù.
        this.setStatus({ state: "reconnecting", ownId, ownName, error: "Mất kết nối Zalo, đang tự nối lại…" });
        this.scheduleReconnect();
      }
    });
    api.listener.on("connected", () => {
      this.reconnectAttempt = 0;
    });

    api.listener.start({ retryOnClose: true });
    this.setStatus({ state: "connected", ownId, ownName });
  }

  private stopListener() {
    try {
      this.api?.listener.stop();
    } catch {
      /* đã dừng */
    }
    this.api = null;
  }

  async logout(): Promise<void> {
    this.cancelReconnect();
    this.loginAbort?.();
    this.setStatus({ state: "logged_out" });
    this.stopListener();
    this.settings.set(this.credentialsKey, "");
    this.releaseLock();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelReconnect();
    this.stopListener();
    this.releaseLock();
  }

  private requireApi(): API {
    if (!this.api || this.status.state !== "connected") throw new Error("Zalo chưa kết nối");
    return this.api;
  }

  async groupName(groupId: string): Promise<string> {
    const cached = this.groupNames.get(groupId);
    if (cached !== undefined) return cached;
    try {
      const res = (await withTimeout(this.requireApi().getGroupInfo(groupId), 8_000)) as { gridInfoMap?: Record<string, { name?: string }> };
      const name = String(res?.gridInfoMap?.[groupId]?.name ?? "");
      this.groupNames.set(groupId, name);
      return name;
    } catch {
      return "";
    }
  }

  async groups() {
    const api = this.requireApi();
    const ownId = String(api.getOwnId());
    const all = (await api.getAllGroups()) as { gridVerMap?: Record<string, unknown> };
    const ids = Object.keys(all?.gridVerMap ?? {});
    const info: Record<string, { name?: string; totalMember?: number; adminIds?: string[]; creatorId?: string }> = {};
    for (const batch of chunked(ids, 100)) {
      const res = (await api.getGroupInfo(batch)) as { gridInfoMap?: typeof info };
      Object.assign(info, res?.gridInfoMap ?? {});
    }
    const list = ids.map((id) => ({
      ...publicGroup(id, info[id]),
      isAdmin: String(info[id]?.creatorId ?? "") === ownId || (info[id]?.adminIds ?? []).map(String).includes(ownId),
    }));
    for (const g of list) this.groupNames.set(g.id, g.name);
    return list.sort((a, b) => a.name.localeCompare(b.name, "vi"));
  }

  /** Thông tin một nhóm kèm toàn bộ id thành viên (để chụp mốc và đối chiếu). */
  async groupDetail(groupId: string): Promise<GroupDetail> {
    const res = (await withTimeout(this.requireApi().getGroupInfo(groupId), 15_000)) as {
      gridInfoMap?: Record<string, { name?: string; totalMember?: number; memVerList?: string[]; memberIds?: string[]; adminIds?: string[]; creatorId?: string }>;
    };
    const g = res?.gridInfoMap?.[groupId];
    if (!g) throw new Error("Không đọc được nhóm này (nick không còn trong nhóm?)");
    const detail: GroupDetail = {
      id: groupId,
      name: String(g.name ?? ""),
      totalMember: Number(g.totalMember ?? 0),
      memberIds: memberIdsFromInfo(g),
      adminIds: (g.adminIds ?? []).map(String),
      creatorId: String(g.creatorId ?? ""),
    };
    this.groupNames.set(groupId, detail.name);
    return detail;
  }

  /**
   * Hồ sơ nhiều người (tên + giới tính) qua getUserInfo, theo lô 50. getGroupMembersInfo không có giới tính
   * nên phải hỏi riêng. Lô nào lỗi thì bỏ qua; người không có trong kết quả là Zalo không trả hồ sơ.
   */
  async userProfiles(ids: string[]): Promise<Map<string, { name: string; gender: Gender; phone: string }>> {
    const api = this.requireApi();
    const out = new Map<string, { name: string; gender: Gender; phone: string }>();
    for (const batch of chunked(ids, 50)) {
      try {
        const res = (await withTimeout(api.getUserInfo(batch), 15_000)) as {
          changed_profiles?: Record<string, { displayName?: string; zaloName?: string; gender?: unknown; phoneNumber?: string }>;
        };
        for (const [id, p] of Object.entries(res?.changed_profiles ?? {})) {
          out.set(String(id).split("_")[0]!, {
            name: String(p?.displayName || p?.zaloName || ""),
            gender: genderFromZalo(p?.gender),
            // Zalo chỉ trả số khi là bạn bè hoặc người đó cho xem số; dùng để tra khách trong CRM.
            phone: String(p?.phoneNumber ?? "").replace(/\D/g, ""),
          });
        }
      } catch {
        /* giới tính chỉ để xưng hô */
      }
    }
    return out;
  }

  /**
   * Tìm tài khoản Zalo theo nhiều số điện thoại (0xxxxxxxxx) một lần gọi. Số không có Zalo hoặc người đó tắt
   * "cho tìm theo số" thì vắng trong kết quả. Lỗi (kể cả Zalo báo tìm quá nhiều) ném ra cho người gọi xử lý.
   */
  async usersByPhones(phones: string[]): Promise<Map<string, { uid: string; name: string }>> {
    const api = this.requireApi();
    const res = (await withTimeout(api.getMultiUsersByPhones(phones), 20_000, "Tìm theo số")) as Record<
      string,
      { uid?: string; zalo_name?: string; display_name?: string } | null
    >;
    const out = new Map<string, { uid: string; name: string }>();
    for (const [key, u] of Object.entries(res ?? {})) {
      if (!u?.uid) continue;
      let d = key.replace(/\D/g, "");
      if (d.startsWith("84") && d.length >= 11) d = `0${d.slice(2)}`;
      out.set(d, { uid: String(u.uid), name: String(u.display_name || u.zalo_name || "") });
    }
    return out;
  }

  /** Tên hiển thị của nhiều người (theo lô 50). Ai không đọc được thì bỏ trống. */
  async memberNames(ids: string[]): Promise<Map<string, string>> {
    const api = this.requireApi();
    const out = new Map<string, string>();
    for (const batch of chunked(ids, 50)) {
      try {
        const res = (await withTimeout(api.getGroupMembersInfo(batch), 15_000)) as { profiles?: Record<string, { displayName?: string; zaloName?: string }> };
        for (const [id, p] of Object.entries(res?.profiles ?? {})) out.set(String(id).split("_")[0]!, String(p?.displayName || p?.zaloName || ""));
      } catch {
        /* tên chỉ để hiển thị */
      }
    }
    return out;
  }

  /** Gửi một tin vào nhóm có tag tên người (lời chào thành viên mới). Tin ngắn, không chia nhỏ. */
  async sendMention(groupId: string, text: string, mentions: { pos: number; uid: string; len: number }[]): Promise<string | null> {
    const api = this.requireApi();
    const decision = this.pacer.reserve(Date.now(), false);
    if (!decision.ok) throw new Error(decision.reason);
    await sleep(decision.waitMs);
    await api.sendTypingEvent(groupId, ZThreadType.Group).catch(() => undefined);
    await sleep(typingDelayMs(text));
    const res = (await withTimeout(api.sendMessage({ msg: text, mentions }, groupId, ZThreadType.Group), SEND_TIMEOUT_MS, "Gửi tin")) as {
      message?: { msgId?: string | number } | null;
    };
    const id = String(res?.message?.msgId ?? "");
    if (id) this.sentIds.add(id);
    return id || null;
  }

  /**
   * Gửi lời mời kết bạn kèm lời nhắn (Zalo cắt ở 150 ký tự). Đã là bạn hoặc Zalo từ chối thì ném lỗi
   * kèm mã của Zalo để ghi vào nhật ký gửi.
   */
  async sendFriendRequest(userId: string, message: string): Promise<void> {
    const api = this.requireApi();
    try {
      await api.sendFriendRequest(message.slice(0, 150), userId);
    } catch (err) {
      const code = (err as { code?: number }).code;
      throw new Error(`${(err as Error).message}${code ? ` (mã ${code})` : ""}`);
    }
  }

  /**
   * Gửi tin chữ. Chờ người kia ngừng gõ, hiện "đang soạn tin", giữ nhịp an toàn.
   * Trả về id các tin đã gửi (tin dài được chia nhỏ).
   */
  async sendText(threadId: string, threadType: ThreadType, text: string, opts: { proactive?: boolean } = {}): Promise<string[]> {
    const api = this.requireApi();
    const zType = threadType === "group" ? ZThreadType.Group : ZThreadType.User;
    const ids: string[] = [];
    for (const part of splitLongText(text)) {
      const decision = this.pacer.reserve(Date.now(), opts.proactive);
      if (!decision.ok) throw new Error(decision.reason);
      await sleep(decision.waitMs);
      for (let wait = remainingQuietMs(this.typingUntil.get(threadId)); wait > 0; wait = remainingQuietMs(this.typingUntil.get(threadId))) {
        await sleep(wait);
      }
      await api.sendTypingEvent(threadId, zType).catch(() => undefined);
      await sleep(typingDelayMs(part));
      const res = (await withTimeout(api.sendMessage({ msg: part }, threadId, zType), SEND_TIMEOUT_MS, "Gửi tin")) as {
        message?: { msgId?: string | number } | null;
      };
      const id = String(res?.message?.msgId ?? "");
      if (id) {
        this.sentIds.add(id);
        if (this.sentIds.size > 2_000) this.sentIds.delete(this.sentIds.values().next().value!);
        ids.push(id);
      }
    }
    return ids;
  }

  /**
   * Danh sách nhãn (Phân loại) của tài khoản, nhớ đệm 60 giây.
   * Trả về null khi chưa kết nối hoặc Zalo lỗi — người gọi phải coi như "không có nhãn".
   */
  async labels(force = false): Promise<unknown[] | null> {
    if (!force && this.labelsCache && Date.now() - this.labelsCache.at < LABELS_TTL_MS) {
      return this.labelsCache.data as unknown[] | null;
    }
    if (!this.isConnected()) return null;
    try {
      const res = (await withTimeout(this.api!.getLabels(), 8_000, "Đọc nhãn")) as { labelData?: unknown[] };
      const data = Array.isArray(res?.labelData) ? res.labelData : null;
      this.labelsCache = { at: Date.now(), data };
      return data;
    } catch {
      return null;
    }
  }

  /**
   * Gắn nhãn THẬT trong Zalo cho một hội thoại (thấy ngay trên điện thoại/máy tính):
   * gỡ khỏi các nhãn trong `exclusive`, gắn vào `target` (null = chỉ gỡ); nhãn chưa có thì tạo.
   * Đọc lại để xác nhận; Zalo đổi phiên bản giữa chừng thì thử lại.
   */
  async setLabel(threadId: string, type: ThreadType, target: string | null, exclusive: string[]): Promise<{ created: string | null }> {
    const api = this.requireApi();
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const cur = (await withTimeout(api.getLabels(), 8_000, "Đọc nhãn")) as { labelData: LabelData[]; version: number };
        const change = applyLabelChange(cur.labelData ?? [], threadId, type, target, exclusive);
        await withTimeout(api.updateLabels({ labelData: change.labels, version: cur.version }), 10_000, "Ghi nhãn");
        const after = (await withTimeout(api.getLabels(), 8_000, "Đọc nhãn")) as { labelData: LabelData[] };
        this.labelsCache = { at: Date.now(), data: after.labelData ?? null };
        const ok =
          (!target || hasLabel(after.labelData ?? [], target, threadId)) &&
          exclusive.filter((n) => !target || n.toLocaleLowerCase("vi") !== target.toLocaleLowerCase("vi")).every((n) => !hasLabel(after.labelData ?? [], n, threadId));
        if (ok) return { created: change.created };
        lastError = new Error("Zalo chưa ghi nhận thay đổi nhãn");
      } catch (err) {
        lastError = err;
      }
      await sleep(300 * (attempt + 1));
    }
    throw new Error(`Không gắn được nhãn trên Zalo: ${(lastError as Error)?.message ?? "lỗi không rõ"}`);
  }

  /** Danh sách nhãn kèm số hội thoại mỗi nhãn (không lộ id). */
  async labelInfo() {
    const data = (await this.labels(true)) as LabelData[] | null;
    return data ? labelSummaries(data) : null;
  }

  /** Tên các nhãn đang có trong Zalo, để gợi ý khi đặt tag cho tính cách. */
  async labelNames(): Promise<string[]> {
    const data = await this.labels();
    return (data ?? []).map((l) => String((l as { text?: unknown })?.text ?? "").trim()).filter(Boolean);
  }

  /** Gửi một hoặc nhiều ảnh (không kèm chữ). Tin lịch hẹn đi qua đây rồi mới gửi chữ. */
  async sendImages(threadId: string, threadType: ThreadType, imagePaths: string[]): Promise<string[]> {
    if (imagePaths.length === 0) return [];
    const api = this.requireApi();
    const zType = threadType === "group" ? ZThreadType.Group : ZThreadType.User;
    const decision = this.pacer.reserve(Date.now(), false);
    if (!decision.ok) throw new Error(decision.reason);
    await sleep(decision.waitMs);
    const res = (await withTimeout(
      api.sendMessage({ msg: "", attachments: imagePaths }, threadId, zType),
      SEND_TIMEOUT_MS * 3,
      "Gửi ảnh",
    )) as { attachment?: { msgId?: string | number }[] };
    const ids = (res?.attachment ?? []).map((a) => String(a?.msgId ?? "")).filter(Boolean);
    for (const id of ids) this.sentIds.add(id);
    return ids;
  }

  isConnected(): boolean {
    return this.status.state === "connected" && this.api !== null;
  }

  // ---- Khoá: một tài khoản Zalo chỉ một trợ lý chạy trên máy này ----
  /**
   * Khoá "một nick chỉ một tiến trình": file ghi PID, người giữ ghi lại file mỗi 30 giây.
   * Khoá không được ghi lại quá 2 phút là khoá bỏ quên (app bị tắt ngang) — kể cả khi Windows đã cấp lại đúng số
   * PID đó cho một chương trình khác (từng gặp: PID cũ thành conhost, app mới không kết nối được Zalo).
   */
  private acquireLock() {
    try {
      const pid = Number(fs.readFileSync(this.lockFile, "utf8"));
      const fresh = Date.now() - fs.statSync(this.lockFile).mtimeMs < LOCK_STALE_MS;
      if (pid && pid !== process.pid && fresh && processAlive(pid)) {
        throw new Error(`Một tiến trình Trợ lý CDN khác (PID ${pid}) đang giữ kết nối Zalo trên máy này.`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" && !(err instanceof SyntaxError)) {
        if (err instanceof Error && err.message.startsWith("Một tiến trình")) throw err;
      }
    }
    fs.mkdirSync(path.dirname(this.lockFile), { recursive: true });
    fs.writeFileSync(this.lockFile, String(process.pid));
    if (!this.lockBeat) {
      this.lockBeat = setInterval(() => {
        try {
          if (Number(fs.readFileSync(this.lockFile, "utf8")) === process.pid) fs.writeFileSync(this.lockFile, String(process.pid));
        } catch {
          /* khoá đã bị gỡ */
        }
      }, 30_000);
      this.lockBeat.unref();
    }
  }

  private releaseLock() {
    if (this.lockBeat) clearInterval(this.lockBeat);
    this.lockBeat = null;
    try {
      if (Number(fs.readFileSync(this.lockFile, "utf8")) === process.pid) fs.rmSync(this.lockFile);
    } catch {
      /* không có khoá */
    }
  }
}

/** Khoá Zalo không được người giữ ghi lại quá ngần này thì coi là bỏ quên. */
export const LOCK_STALE_MS = 120_000;

export async function readImageMetadata(filePath: string): Promise<{ width: number; height: number; size: number } | null> {
  try {
    const data = await fs.promises.readFile(filePath);
    const { width, height } = imageSize(data);
    return width && height ? { width, height, size: data.length } : null;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
