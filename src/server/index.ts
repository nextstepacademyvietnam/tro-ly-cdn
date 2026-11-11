import { buildApp } from "./app.js";
import { APP_VERSION, DATA_DIR, HOST, INSTALL_DIR, INSTALL_KIND, PACKAGE_INFO, PORT, WEB_DIR } from "./config.js";
import { RESTART_EXIT_CODE, Updater, repoFromPackage } from "./updates.js";
import { AssistantStore } from "../core/assistantStore.js";
import { openDb } from "./db.js";
import { SecretBox } from "./secrets.js";
import { Settings } from "./settings.js";
import { AccountManager } from "../channels/zalo/accounts.js";
import { ProfileStore } from "../core/profiles.js";
import { ScheduleStore } from "../scheduler/store.js";
import { ScheduleRunner } from "../scheduler/runner.js";

const db = openDb();
const box = SecretBox.fromDataDir();
let log: (msg: string, extra?: object) => void = () => {};
const accounts = new AccountManager(db, new Settings(db, box), DATA_DIR, (msg, extra) => log(msg, extra));
const scheduleStore = new ScheduleStore(db, DATA_DIR);
const runner = new ScheduleRunner(scheduleStore, accounts, (msg, extra) => log(msg, extra));

// Hỏi GitHub Releases của repo ghi trong package.json (bản fork tự trỏ về repo của mình).
// CDN_UPDATE_CHECK=0 để tắt; CDN_UPDATE_URL để trỏ nơi khác khi thử nghiệm.
const repo = repoFromPackage(PACKAGE_INFO);
const releaseUrl =
  process.env.CDN_UPDATE_CHECK === "0"
    ? null
    : (process.env.CDN_UPDATE_URL ?? (repo ? `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/latest` : null));
const notices = new AssistantStore(db);
const updater = new Updater({
  current: APP_VERSION,
  settings: new Settings(db, box),
  db,
  dataDir: DATA_DIR,
  installDir: INSTALL_DIR,
  installKind: INSTALL_KIND,
  releaseUrl,
  restart: () => shutdown(RESTART_EXIT_CODE),
  onNewVersion: (r) => {
    for (const a of accounts.list()) notices.notify(a.id, "update", `Có bản mới v${r.version}. Mở app để xem thay đổi và cập nhật.`);
  },
  log: (msg, extra) => log(msg, extra),
});

const app = await buildApp({
  db,
  box,
  dataDir: DATA_DIR,
  accounts,
  profiles: new ProfileStore(db),
  schedules: { store: scheduleStore, runner },
  webDir: WEB_DIR,
  updater,
  version: APP_VERSION,
  secureCookies: process.env.SECURE_COOKIES === "1",
});
log = (msg, extra) => app.log.info(extra ?? {}, msg);

let closing = false;
const shutdown = async (code = 0) => {
  if (closing) return;
  closing = true;
  runner.stop();
  await accounts.stopAll();
  await app.close();
  db.close();
  process.exit(code);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await app.listen({ port: PORT, host: HOST });
app.log.info(`Trợ lý CDN đang chạy: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
void accounts.startAll();
runner.start();
updater.start();
