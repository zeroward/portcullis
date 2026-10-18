import type { Queryable } from "../db/index.js";
import { randomUUID } from "node:crypto";
import { redact } from "../security.js";
export async function audit(
  db: Queryable,
  actor: string | null,
  action: string,
  target: string,
  details: any = {},
  subject: string | null = null,
  outcome = "success",
  correlation = randomUUID(),
) {
  await db.query(
    "INSERT INTO audit_events(actor_id,subject_id,target,action,outcome,correlation_id,details) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [
      actor,
      subject,
      target,
      action,
      outcome,
      correlation,
      JSON.stringify(redact(details)),
    ],
  );
}
export async function notify(
  db: Queryable,
  user: string,
  kind: string,
  body: string,
  link: string,
  dedupe: string,
) {
  const [n] = await db.query(
    "INSERT INTO notifications(user_id,kind,body,link,dedupe) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id",
    [user, kind, body, link, dedupe],
  );
  if (n)
    await enqueue(
      db,
      "notification",
      user,
      { notificationId: n.id },
      `notification:${n.id}`,
    );
}
export async function enqueue(
  db: Queryable,
  kind: string,
  user: string | null,
  payload: any,
  dedupe: string,
  priority = 0,
) {
  await db.query(
    "INSERT INTO jobs(kind,user_id,payload,dedupe,priority) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(dedupe) DO NOTHING",
    [kind, user, JSON.stringify(payload), dedupe, priority],
  );
}
