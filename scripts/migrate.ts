import { readFile, readdir } from "node:fs/promises";
import { Database } from "../src/db/index.js";
export async function migrate(db: Database) {
  await db.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  for (const name of (await readdir("migrations"))
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    await db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(770012)");
      if (
        (
          await tx.query("SELECT name FROM schema_migrations WHERE name=$1", [
            name,
          ])
        ).length
      )
        return;
      await tx.query(await readFile(`migrations/${name}`, "utf8"));
      await tx.query("INSERT INTO schema_migrations(name) VALUES ($1)", [name]);
    });
  }
}
if (
  process.argv[1]?.endsWith("migrate.ts") ||
  process.argv[1]?.endsWith("migrate.js")
) {
  const db = new Database(process.env.DATABASE_URL!);
  try {
    await migrate(db);
    console.log("Migrations applied");
  } finally {
    await db.close();
  }
}
