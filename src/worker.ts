import { randomUUID } from "node:crypto";
import { Database } from "./db/index.js";
import { loadConfig } from "./config.js";
import { integrationClients } from "./app.js";
import { Jobs } from "./domain/jobs.js";
import { Admin } from "./domain/admin.js";
import { Monitoring } from "./monitoring.js";
import { Notifications } from "./notifications.js";
import { Devices } from "./domain/devices.js";
const config = loadConfig();
const db = new Database(config.DATABASE_URL);
const clients = integrationClients(config);
const jobs = new Jobs(db, clients);
const admin = new Admin(db, config, clients);
const monitor = new Monitoring(
  db,
  config,
  (id) => admin.getSecret(id),
  clients.pterodactyl,
);
const notifications = new Notifications(db, config);
const devices = new Devices(db, config, clients.netbird);
const worker = randomUUID();
let stop = false;
let lastSweep = 0;
for (const s of ["SIGINT", "SIGTERM"] as const)
  process.on(s, () => {
    stop = true;
  });
while (!stop) {
  await db.query(
    "INSERT INTO worker_heartbeats(id) VALUES ($1) ON CONFLICT(id) DO UPDATE SET seen_at=now()",
    [worker],
  );
  if (Date.now() - lastSweep > 30000) {
    try {
      await jobs.maintenance();
      await devices.sync();
      lastSweep = Date.now();
    } catch {
      console.error(JSON.stringify({ event: "maintenance_failed", worker }));
    }
  }
  const ran = await jobs.runOne(async (kind, payload) => {
    if (kind === "health") await monitor.poll(payload.checkId);
    else if (kind === "notification")
      await notifications.deliver(payload.notificationId);
    else throw new Error("unknown_job_kind");
  });
  if (!ran) await new Promise((r) => setTimeout(r, 1000));
}
await db.close();
