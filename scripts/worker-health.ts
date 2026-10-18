import { Database } from "../src/db/index.js";
const db = new Database(process.env.DATABASE_URL!);
try {
  const [row] = await db.query(
    "SELECT EXISTS(SELECT 1 FROM worker_heartbeats WHERE seen_at>now()-interval '90 seconds') AS healthy",
  );
  process.exitCode = row?.healthy ? 0 : 1;
} catch {
  process.exitCode = 1;
} finally {
  await db.close();
}
