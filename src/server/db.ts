import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { DATA_DIR, ensureDataDir } from "./config.js";

export type DB = DatabaseSync;

const MIGRATIONS: string[] = [
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY,
     username TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     expires_at INTEGER NOT NULL
   );
   CREATE TABLE settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );`,
  // Mốc 2: hộp thư Zalo
  `CREATE TABLE conversations (
     thread_id TEXT PRIMARY KEY,
     thread_type TEXT NOT NULL CHECK (thread_type IN ('user', 'group')),
     name TEXT NOT NULL DEFAULT '',
     last_text TEXT NOT NULL DEFAULT '',
     last_message_at INTEGER NOT NULL DEFAULT 0,
     unread INTEGER NOT NULL DEFAULT 0,
     reply_mode TEXT NOT NULL DEFAULT 'off' CHECK (reply_mode IN ('off', 'draft', 'auto'))
   );
   CREATE INDEX conversations_recent ON conversations (last_message_at DESC);
   CREATE TABLE messages (
     id INTEGER PRIMARY KEY,
     thread_id TEXT NOT NULL REFERENCES conversations(thread_id) ON DELETE CASCADE,
     zalo_msg_id TEXT,
     sender_id TEXT NOT NULL DEFAULT '',
     sender_name TEXT NOT NULL DEFAULT '',
     direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
     source TEXT NOT NULL DEFAULT 'zalo' CHECK (source IN ('zalo', 'owner', 'ai')),
     text TEXT,
     kind TEXT NOT NULL DEFAULT 'text',
     created_at INTEGER NOT NULL
   );
   CREATE UNIQUE INDEX messages_zalo_id ON messages (thread_id, zalo_msg_id) WHERE zalo_msg_id IS NOT NULL AND zalo_msg_id <> '';
   CREATE INDEX messages_thread_time ON messages (thread_id, created_at);`,
  // Tài liệu hướng dẫn cho trợ lý (chủ tải lên)
  `CREATE TABLE persona_files (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     text TEXT NOT NULL,
     bytes INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   );`,
  // Lịch gửi tin tự động
  `CREATE TABLE media (
     id INTEGER PRIMARY KEY,
     file TEXT NOT NULL,
     name TEXT NOT NULL,
     mime TEXT NOT NULL,
     bytes INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE schedules (
     id INTEGER PRIMARY KEY,
     title TEXT NOT NULL DEFAULT '',
     text TEXT NOT NULL DEFAULT '',
     image_ids TEXT NOT NULL DEFAULT '[]',
     recurrence TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'cancelled', 'done')),
     next_run_at INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX schedules_due ON schedules (status, next_run_at);
   CREATE TABLE schedule_targets (
     schedule_id INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
     thread_id TEXT NOT NULL,
     thread_type TEXT NOT NULL CHECK (thread_type IN ('user', 'group')),
     name TEXT NOT NULL DEFAULT '',
     PRIMARY KEY (schedule_id, thread_id)
   );
   CREATE INDEX schedule_targets_thread ON schedule_targets (thread_id);
   CREATE TABLE schedule_runs (
     id INTEGER PRIMARY KEY,
     schedule_id INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
     thread_id TEXT NOT NULL,
     planned_at INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'missed')),
     error TEXT NOT NULL DEFAULT '',
     done_at INTEGER NOT NULL,
     manual INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX schedule_runs_schedule ON schedule_runs (schedule_id, done_at DESC);`,
  // Nhiều tài khoản Zalo + nhiều tính cách gắn tag. Dữ liệu cũ thành "Tài khoản 1",
  // hướng dẫn cũ thành tính cách đầu tiên.
  `CREATE TABLE accounts (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     own_id TEXT NOT NULL DEFAULT '',
     off_tag TEXT NOT NULL DEFAULT 'Không bot',
     created_at INTEGER NOT NULL
   );
   INSERT INTO accounts (id, name, created_at) VALUES (1, 'Tài khoản 1', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
   UPDATE settings SET key = 'zalo.credentials.1' WHERE key = 'zalo.credentials';

   CREATE TABLE conversations_new (
     account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     thread_id TEXT NOT NULL,
     thread_type TEXT NOT NULL CHECK (thread_type IN ('user', 'group')),
     name TEXT NOT NULL DEFAULT '',
     last_text TEXT NOT NULL DEFAULT '',
     last_message_at INTEGER NOT NULL DEFAULT 0,
     unread INTEGER NOT NULL DEFAULT 0,
     assigned_profile_id INTEGER,
     assigned_off INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (account_id, thread_id)
   );
   INSERT INTO conversations_new (account_id, thread_id, thread_type, name, last_text, last_message_at, unread)
     SELECT 1, thread_id, thread_type, name, last_text, last_message_at, unread FROM conversations;
   CREATE TABLE messages_new (
     id INTEGER PRIMARY KEY,
     account_id INTEGER NOT NULL,
     thread_id TEXT NOT NULL,
     zalo_msg_id TEXT,
     sender_id TEXT NOT NULL DEFAULT '',
     sender_name TEXT NOT NULL DEFAULT '',
     direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
     source TEXT NOT NULL DEFAULT 'zalo' CHECK (source IN ('zalo', 'owner', 'ai')),
     text TEXT,
     kind TEXT NOT NULL DEFAULT 'text',
     created_at INTEGER NOT NULL,
     FOREIGN KEY (account_id, thread_id) REFERENCES conversations_new(account_id, thread_id) ON DELETE CASCADE
   );
   INSERT INTO messages_new (id, account_id, thread_id, zalo_msg_id, sender_id, sender_name, direction, source, text, kind, created_at)
     SELECT id, 1, thread_id, zalo_msg_id, sender_id, sender_name, direction, source, text, kind, created_at FROM messages;
   DROP TABLE messages;
   DROP TABLE conversations;
   ALTER TABLE conversations_new RENAME TO conversations;
   ALTER TABLE messages_new RENAME TO messages;
   CREATE INDEX conversations_recent ON conversations (account_id, last_message_at DESC);
   CREATE UNIQUE INDEX messages_zalo_id ON messages (account_id, thread_id, zalo_msg_id) WHERE zalo_msg_id IS NOT NULL AND zalo_msg_id <> '';
   CREATE INDEX messages_thread_time ON messages (account_id, thread_id, created_at);

   CREATE TABLE profiles (
     id INTEGER PRIMARY KEY,
     account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     tag TEXT NOT NULL DEFAULT '',
     prompt TEXT NOT NULL DEFAULT '',
     send_mode TEXT NOT NULL DEFAULT 'draft' CHECK (send_mode IN ('draft', 'auto')),
     applies TEXT NOT NULL DEFAULT 'both' CHECK (applies IN ('both', 'user', 'group')),
     priority INTEGER NOT NULL DEFAULT 100,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   INSERT INTO profiles (id, account_id, name, tag, prompt, created_at, updated_at)
     VALUES (1, 1, 'Chăm sóc khách hàng', 'Bot CSKH',
       COALESCE((SELECT json_extract(value, '$') FROM settings WHERE key = 'persona'),
         'Bạn là trợ lý chăm sóc khách hàng, nói tiếng Việt tự nhiên, lịch sự, ngắn gọn. Không bịa thông tin; không chắc thì nói không chắc.'),
       CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
   DELETE FROM settings WHERE key = 'persona';
   ALTER TABLE persona_files ADD COLUMN profile_id INTEGER REFERENCES profiles(id) ON DELETE CASCADE;
   UPDATE persona_files SET profile_id = 1;
   ALTER TABLE schedules ADD COLUMN account_id INTEGER NOT NULL DEFAULT 1;
   CREATE INDEX schedules_account ON schedules (account_id);`,
  // Mốc 3: AI trả lời khách — nháp chờ duyệt, chuyển người thật, thông báo cho chủ, tạm dừng.
  `ALTER TABLE accounts ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE conversations ADD COLUMN handoff_until INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE conversations ADD COLUMN handoff_reason TEXT NOT NULL DEFAULT '';
   ALTER TABLE conversations ADD COLUMN no_proactive INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE drafts (
     id INTEGER PRIMARY KEY,
     account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     thread_id TEXT NOT NULL,
     profile_id INTEGER,
     text TEXT NOT NULL,
     handoff INTEGER NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'discarded', 'superseded', 'failed')),
     error TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     decided_at INTEGER
   );
   CREATE INDEX drafts_pending ON drafts (account_id, status, thread_id);
   CREATE TABLE notifications (
     id INTEGER PRIMARY KEY,
     account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     thread_id TEXT NOT NULL DEFAULT '',
     kind TEXT NOT NULL,
     text TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     read INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX notifications_recent ON notifications (account_id, created_at DESC);`,
  // Hướng dẫn AI theo 4 tầng: tầng 1 theo ô (identity), tầng 2 thêm hỏi đáp, tầng 3 ghi chú có hạn.
  // Hướng dẫn cũ (một khối chữ) chuyển vào ô "Ghi chú thêm" của tầng 1.
  `ALTER TABLE profiles ADD COLUMN identity TEXT NOT NULL DEFAULT '{}';
   UPDATE profiles SET identity = json_object('notes', prompt) WHERE prompt <> '';
   ALTER TABLE profiles ADD COLUMN stale_reminded_at INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE profile_faqs (
     id INTEGER PRIMARY KEY,
     profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
     question TEXT NOT NULL,
     answer TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE profile_notes (
     id INTEGER PRIMARY KEY,
     profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
     text TEXT NOT NULL,
     expires_on TEXT,
     reminded INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );`,
  // Theo dõi nhóm Zalo: thành viên, sự kiện vào/rời, luồng chào mừng.
  `CREATE TABLE tracked_groups (
     account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     group_id TEXT NOT NULL,
     name TEXT NOT NULL DEFAULT '',
     member_count INTEGER NOT NULL DEFAULT 0,
     tracked_at INTEGER NOT NULL,
     reconciled_at INTEGER NOT NULL DEFAULT 0,
     welcome TEXT NOT NULL DEFAULT '{}',
     PRIMARY KEY (account_id, group_id)
   );
   CREATE TABLE group_members (
     account_id INTEGER NOT NULL,
     group_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     name TEXT NOT NULL DEFAULT '',
     present INTEGER NOT NULL DEFAULT 1,
     first_seen_at INTEGER NOT NULL,
     joined_at INTEGER,
     left_at INTEGER,
     PRIMARY KEY (account_id, group_id, user_id),
     FOREIGN KEY (account_id, group_id) REFERENCES tracked_groups(account_id, group_id) ON DELETE CASCADE
   );
   CREATE TABLE group_events (
     id INTEGER PRIMARY KEY,
     account_id INTEGER NOT NULL,
     group_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     user_name TEXT NOT NULL DEFAULT '',
     kind TEXT NOT NULL CHECK (kind IN ('join', 'leave', 'remove', 'block')),
     via TEXT NOT NULL DEFAULT '',
     actor_id TEXT NOT NULL DEFAULT '',
     actor_name TEXT NOT NULL DEFAULT '',
     at INTEGER NOT NULL,
     FOREIGN KEY (account_id, group_id) REFERENCES tracked_groups(account_id, group_id) ON DELETE CASCADE
   );
   CREATE INDEX group_events_time ON group_events (account_id, group_id, at);
   CREATE TABLE group_welcomes (
     id INTEGER PRIMARY KEY,
     account_id INTEGER NOT NULL,
     group_id TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('group', 'private')),
     members TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
     due_at INTEGER NOT NULL,
     done_at INTEGER,
     text TEXT NOT NULL DEFAULT '',
     error TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     FOREIGN KEY (account_id, group_id) REFERENCES tracked_groups(account_id, group_id) ON DELETE CASCADE
   );
   CREATE INDEX group_welcomes_due ON group_welcomes (status, due_at);`,
  // Mục MKT: kết nối nền tảng (Facebook, YouTube, TikTok, quảng cáo Meta, Pancake, Google Sheet), số theo ngày, bài đăng.
  // Không theo tài khoản Zalo: một bộ kết nối cho cả app. Ngày là ngày VN dạng YYYY-MM-DD (Facebook theo nhãn ngày của Meta).
  `CREATE TABLE mkt_connections (
     kind TEXT PRIMARY KEY,
     label TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'off' CHECK (status IN ('off', 'ok', 'error')),
     error TEXT NOT NULL DEFAULT '',
     secret TEXT NOT NULL DEFAULT '',
     meta TEXT NOT NULL DEFAULT '{}',
     connected_at INTEGER NOT NULL DEFAULT 0,
     pulled_at INTEGER NOT NULL DEFAULT 0,
     data_until TEXT NOT NULL DEFAULT ''
   );
   CREATE TABLE mkt_daily (
     kind TEXT NOT NULL,
     metric TEXT NOT NULL,
     day TEXT NOT NULL,
     value REAL NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (kind, metric, day)
   );
   CREATE TABLE mkt_posts (
     kind TEXT NOT NULL,
     post_id TEXT NOT NULL,
     day TEXT NOT NULL,
     title TEXT NOT NULL DEFAULT '',
     url TEXT NOT NULL DEFAULT '',
     views INTEGER,
     comments INTEGER,
     reactions INTEGER,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (kind, post_id)
   );
   CREATE INDEX mkt_posts_day ON mkt_posts (kind, day);
   CREATE TABLE mkt_runs (
     id INTEGER PRIMARY KEY,
     kind TEXT NOT NULL,
     ok INTEGER NOT NULL,
     message TEXT NOT NULL DEFAULT '',
     at INTEGER NOT NULL
   );`,
  // Giới tính khách (từ hồ sơ Zalo hoặc chủ sửa tay) để gọi anh / chị / bạn.
  `CREATE TABLE contacts (
     account_id INTEGER NOT NULL,
     user_id TEXT NOT NULL,
     name TEXT NOT NULL DEFAULT '',
     gender TEXT NOT NULL DEFAULT '' CHECK (gender IN ('nam', 'nu', '')),
     gender_source TEXT NOT NULL DEFAULT 'zalo' CHECK (gender_source IN ('zalo', 'chu')),
     fetched_at INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (account_id, user_id)
   );`,
  // Chăm sóc khách chủ động: hồ sơ + kế hoạch từng khách (AI đề xuất, chủ sửa), lịch sử chăm sóc,
  // nháp có nguồn gốc (trả lời / chăm sóc), cài đặt chăm sóc theo tính cách.
  `CREATE TABLE care_plans (
     account_id INTEGER NOT NULL,
     thread_id TEXT NOT NULL,
     profile_id INTEGER,
     status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'stopped')),
     stage TEXT NOT NULL DEFAULT '',
     facts TEXT NOT NULL DEFAULT '',
     summary TEXT NOT NULL DEFAULT '',
     needs TEXT NOT NULL DEFAULT '',
     goal TEXT NOT NULL DEFAULT '',
     every_days INTEGER NOT NULL DEFAULT 3,
     next_at INTEGER,
     reason TEXT NOT NULL DEFAULT '',
     stop_reason TEXT NOT NULL DEFAULT '',
     locked INTEGER NOT NULL DEFAULT 0,
     analyzed_at INTEGER NOT NULL DEFAULT 0,
     last_care_at INTEGER NOT NULL DEFAULT 0,
     care_count INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (account_id, thread_id)
   );
   CREATE INDEX care_plans_due ON care_plans (status, next_at);
   CREATE TABLE care_log (
     id INTEGER PRIMARY KEY,
     account_id INTEGER NOT NULL,
     thread_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     text TEXT NOT NULL DEFAULT '',
     at INTEGER NOT NULL
   );
   CREATE INDEX care_log_thread ON care_log (account_id, thread_id, at DESC);
   ALTER TABLE drafts ADD COLUMN origin TEXT NOT NULL DEFAULT 'reply';
   ALTER TABLE profiles ADD COLUMN care_enabled INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE profiles ADD COLUMN care_rules TEXT NOT NULL DEFAULT '';
   ALTER TABLE profiles ADD COLUMN care_max_per_day INTEGER NOT NULL DEFAULT 20;`,
  // Tính cách theo nhóm: thành viên nhóm nhắn riêng mà chưa có nhãn trợ lý thì gắn nhãn tính cách của nhóm.
  // Ghi lại người đã gắn để chủ gỡ nhãn rồi thì không gắn lại.
  `ALTER TABLE tracked_groups ADD COLUMN profile_id INTEGER;
   CREATE TABLE group_persona_applied (
     account_id INTEGER NOT NULL,
     thread_id TEXT NOT NULL,
     profile_id INTEGER NOT NULL,
     group_id TEXT NOT NULL,
     at INTEGER NOT NULL,
     PRIMARY KEY (account_id, thread_id)
   );`,
  // Đợt 1 "nhân viên thật": giữ bản AI soạn gốc khi chủ sửa nháp (để học), khách chờ trả lời lâu
  // (chủ bấm "Không cần trả lời" thì ghi mốc), gợi ý gắn nhãn tính cách cho khách mới, gợi ý hỏi đáp
  // học từ cách chủ trả lời.
  `ALTER TABLE drafts ADD COLUMN original_text TEXT;
   ALTER TABLE conversations ADD COLUMN wait_ok_at INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE conversations ADD COLUMN suggest_profile_id INTEGER;
   ALTER TABLE conversations ADD COLUMN suggest_reason TEXT NOT NULL DEFAULT '';
   ALTER TABLE conversations ADD COLUMN suggest_checked_at INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE conversations ADD COLUMN suggest_dismissed INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE profiles ADD COLUMN learned_at INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE faq_suggestions (
     id INTEGER PRIMARY KEY,
     profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
     question TEXT NOT NULL,
     answer TEXT NOT NULL,
     evidence TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'dismissed')),
     created_at INTEGER NOT NULL,
     decided_at INTEGER
   );
   CREATE INDEX faq_suggestions_profile ON faq_suggestions (profile_id, status);`,
  // Báo chủ qua Zalo của chính họ ("Cloud của tôi"): việc gấp và tóm tắt cuối ngày. Bật sẵn, tắt theo tài khoản.
  `ALTER TABLE accounts ADD COLUMN owner_alerts INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE accounts ADD COLUMN digest_day TEXT NOT NULL DEFAULT '';`,
  // Tra khách trong Pancake CRM từ Hộp thư: API không lọc được theo số điện thoại nên giữ một chỉ mục trên máy
  // (số điện thoại băm SHA-256, không lưu số gốc) + vài trường làm việc. Số chủ tự nhập cho một hội thoại thì lưu riêng.
  `CREATE TABLE crm_index (
     phone_hash TEXT NOT NULL,
     table_name TEXT NOT NULL,
     record_id TEXT NOT NULL,
     created_on TEXT NOT NULL DEFAULT '',
     data TEXT NOT NULL DEFAULT '{}',
     PRIMARY KEY (phone_hash, table_name, record_id)
   );
   CREATE TABLE crm_links (
     account_id INTEGER NOT NULL,
     thread_id TEXT NOT NULL,
     phone TEXT NOT NULL,
     at INTEGER NOT NULL,
     PRIMARY KEY (account_id, thread_id)
   );
   ALTER TABLE contacts ADD COLUMN phone TEXT NOT NULL DEFAULT '';
   UPDATE contacts SET fetched_at = 0 WHERE gender_source <> 'chu';`,
  // Lưu lead từ Zalo vào Pancake CRM: nhớ hội thoại nào đã thành bản ghi nào (lần sau thì cập nhật, không tạo trùng).
  `CREATE TABLE crm_saved (
     account_id INTEGER NOT NULL,
     thread_id TEXT NOT NULL,
     table_name TEXT NOT NULL,
     record_id TEXT NOT NULL,
     phone TEXT NOT NULL DEFAULT '',
     at INTEGER NOT NULL,
     PRIMARY KEY (account_id, thread_id, table_name)
   );
   ALTER TABLE conversations ADD COLUMN crm_phone_noticed TEXT NOT NULL DEFAULT '';`,
  // Nối CRM → Zalo theo số điện thoại: app nhờ Zalo tìm số của lead ra tài khoản Zalo (uid), theo từng nick.
  // Chỉ mục CRM giữ thêm số đã mã hoá (để bộ tìm đọc lại) và mức ưu tiên (0 = khách đang theo).
  `CREATE TABLE crm_zalo (
     account_id INTEGER NOT NULL,
     phone_hash TEXT NOT NULL,
     uid TEXT NOT NULL DEFAULT '',
     zalo_name TEXT NOT NULL DEFAULT '',
     checked_at INTEGER NOT NULL,
     PRIMARY KEY (account_id, phone_hash)
   );
   CREATE INDEX crm_zalo_uid ON crm_zalo (account_id, uid);
   ALTER TABLE crm_index ADD COLUMN priority INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE crm_index ADD COLUMN phone_enc TEXT NOT NULL DEFAULT '';
   CREATE INDEX crm_index_priority ON crm_index (priority, created_on);`,
  // Admin ra lệnh qua Zalo (nhắn riêng cho nick bot) và báo cáo định kỳ chọn chỉ số. Tóm tắt 17:30 cũ chuyển thành
  // một báo cáo hằng ngày gửi vào "Cloud của tôi" (chỉ với tài khoản đang bật báo về Zalo).
  `CREATE TABLE admins (
     account_id INTEGER NOT NULL,
     user_id TEXT NOT NULL,
     name TEXT NOT NULL DEFAULT '',
     added_at INTEGER NOT NULL,
     PRIMARY KEY (account_id, user_id)
   );
   CREATE TABLE reports (
     id INTEGER PRIMARY KEY,
     account_id INTEGER NOT NULL,
     name TEXT NOT NULL DEFAULT '',
     frequency TEXT NOT NULL DEFAULT 'daily' CHECK (frequency IN ('daily', 'weekly')),
     weekday INTEGER NOT NULL DEFAULT 1,
     at_minute INTEGER NOT NULL DEFAULT 1050,
     recipients TEXT NOT NULL DEFAULT '["self"]',
     metrics TEXT NOT NULL DEFAULT '[]',
     enabled INTEGER NOT NULL DEFAULT 1,
     last_key TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL
   );
   INSERT INTO reports (account_id, name, metrics, created_at, last_key)
     SELECT id, 'Tóm tắt cuối ngày', '["messages","ai_sent","pending","waiting","handoff","care"]',
            CAST(strftime('%s', 'now') AS INTEGER) * 1000, digest_day
     FROM accounts WHERE owner_alerts = 1;`,
  // v19: lịch gửi — tag tất cả (@All, chỉ nhóm) và mức độ tin (0 thường, 1 quan trọng, 2 khẩn cấp).
  `ALTER TABLE schedules ADD COLUMN mention_all INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE schedules ADD COLUMN urgency INTEGER NOT NULL DEFAULT 0;`,
  // v20: lịch gửi do AI soạn — mỗi lượt AI viết tin mới theo chủ đề; nháp chờ duyệt hoặc tự gửi.
  // Nháp nhớ cách gửi (@All, mức độ) và lịch sinh ra nó; lượt gửi nhớ nội dung đã gửi để AI không lặp lại.
  `ALTER TABLE schedules ADD COLUMN ai_mode TEXT NOT NULL DEFAULT 'off';
   ALTER TABLE schedules ADD COLUMN ai_brief TEXT NOT NULL DEFAULT '';
   ALTER TABLE schedules ADD COLUMN ai_profile_id INTEGER;
   ALTER TABLE drafts ADD COLUMN send_opts TEXT NOT NULL DEFAULT '';
   ALTER TABLE drafts ADD COLUMN schedule_id INTEGER;
   CREATE TABLE schedule_runs_v20 (
     id INTEGER PRIMARY KEY,
     schedule_id INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
     thread_id TEXT NOT NULL,
     planned_at INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'missed', 'drafted')),
     error TEXT NOT NULL DEFAULT '',
     done_at INTEGER NOT NULL,
     manual INTEGER NOT NULL DEFAULT 0,
     text TEXT NOT NULL DEFAULT ''
   );
   INSERT INTO schedule_runs_v20 (id, schedule_id, thread_id, planned_at, status, error, done_at, manual)
     SELECT id, schedule_id, thread_id, planned_at, status, error, done_at, manual FROM schedule_runs;
   DROP TABLE schedule_runs;
   ALTER TABLE schedule_runs_v20 RENAME TO schedule_runs;
   CREATE INDEX schedule_runs_schedule ON schedule_runs (schedule_id, done_at DESC);`,
];

export function openDb(file = path.join(DATA_DIR, "tro-ly.sqlite")): DB {
  if (file !== ":memory:") ensureDataDir();
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
