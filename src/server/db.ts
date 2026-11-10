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
