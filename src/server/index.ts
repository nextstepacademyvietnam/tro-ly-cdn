import { buildApp } from "./app.js";
import { DATA_DIR, HOST, PORT, WEB_DIR } from "./config.js";
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

const app = await buildApp({
  db,
  box,
  dataDir: DATA_DIR,
  accounts,
  profiles: new ProfileStore(db),
  schedules: { store: scheduleStore, runner },
  webDir: WEB_DIR,
  secureCookies: process.env.SECURE_COOKIES === "1",
});
log = (msg, extra) => app.log.info(extra ?? {}, msg);

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  runner.stop();
  await accounts.stopAll();
  await app.close();
  db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: PORT, host: HOST });
app.log.info(`Trợ lý CDN đang chạy: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
void accounts.startAll();
runner.start();
