import EmbeddedPostgres from "embedded-postgres";
import { mkdir } from "node:fs/promises";
await mkdir(".local", { recursive: true });
const pg = new EmbeddedPostgres({
  databaseDir: ".local/postgres",
  user: "portcullis",
  password: "development",
  port: 5432,
  persistent: true,
  onLog: () => {},
  onError: console.error,
});
await pg.initialise();
await pg.start();
try {
  await pg.createDatabase("portcullis");
} catch {
  /* Already exists on restart. */
}
console.log("Isolated development PostgreSQL on 127.0.0.1:5432");
for (const s of ["SIGINT", "SIGTERM"] as const)
  process.on(s, async () => {
    await pg.stop();
    process.exit(0);
  });
await new Promise(() => {});
