import EmbeddedPostgres from "embedded-postgres";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../src/db/index.js";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { migrate } from "./migrate.js";
import { seed } from "./seed.js";
import { devIssuer } from "./dev-oidc.js";
import { providerFixture } from "../tests/fixtures.js";
import { Jobs } from "../src/domain/jobs.js";
if (process.env.NODE_ENV === "production")
  throw new Error("E2E fixtures forbidden in production");
const dir = await mkdtemp(join(tmpdir(), "portcullis-e2e-"));
const pg = new EmbeddedPostgres({
  databaseDir: join(dir, "db"),
  user: "test",
  password: "test",
  port: 55434,
  persistent: true,
  onLog: () => {},
  onError: () => {},
});
await pg.initialise();
await pg.start();
await pg.createDatabase("e2e");
const db = new Database("postgres://test:test@127.0.0.1:55434/e2e");
await migrate(db);
await seed(db, "test");
const issuer = await devIssuer();
const fixture = await providerFixture();
const config = loadConfig({
  NODE_ENV: "test",
  RATE_LIMIT_MAX: "1000",
  DATABASE_URL: "postgres://test:test@127.0.0.1:55434/e2e",
  BASE_URL: "http://localhost:3000",
  ENCRYPTION_KEY: "1".repeat(64),
  OIDC_ISSUER: issuer.issuer,
  OIDC_CLIENT_ID: "portcullis",
  OIDC_CLIENT_SECRET: "development-secret",
  OWNER_SUBJECT: "dev-owner",
  POCKET_ID_URL: fixture.url,
  POCKET_ID_API_KEY: "pocket-fixture-key",
  NETBIRD_URL: fixture.url,
  NETBIRD_TOKEN: "netbird-fixture-token",
  CAPABILITY_OVERRIDES: '{"netbird.networks":true,"pocket.enrollment":true}',
  UPLOAD_DIR: join(dir, "uploads"),
});
const system = await createApp(config, { db, logger: false });
const jobs = new Jobs(db, system.clients);
const [member] = await db.query(
  "SELECT id FROM users WHERE subject='dev-member'",
);
await db.query(
  "INSERT INTO identity_links(user_id,provider,external_id) VALUES ($1,'pocket-id','pid-member'),($1,'netbird','nb-member')",
  [member.id],
);
const [e] = await db.query(
  `INSERT INTO entitlements(key,name,policy) VALUES ('network.gaming','Gaming network',$1) RETURNING *`,
  [
    JSON.stringify({
      requestable: true,
      approvals: 1,
      noSelfApproval: true,
      maxHours: 720,
      defaultHours: 168,
    }),
  ],
);
await db.query(
  "INSERT INTO bindings(entitlement_id,provider,external_id,managed) VALUES ($1,'pocket-id','pid-gaming',true),($1,'netbird','nb-gaming',true)",
  [e.id],
);
await system.app.listen({ port: 3000, host: "127.0.0.1" });
let stop = false;
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    stop = true;
  });
console.log("Isolated browser-test portal ready");
while (!stop) {
  await jobs.runOne(async () => {});
  await system.devices.sync();
  await new Promise((r) => setTimeout(r, 200));
}
await system.app.close();
await issuer.app.close();
await fixture.app.close();
await db.close();
await pg.stop();
