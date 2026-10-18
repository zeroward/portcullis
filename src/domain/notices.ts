import { z } from "zod";
import type { Database } from "../db/index.js";
import type { Actor } from "./authorization.js";
import { requirePermission, hasServiceAccess, can } from "./authorization.js";
import { audit, notify } from "./audit.js";
import { invariant } from "../errors.js";
export class Notices {
  constructor(readonly db: Database) {}
  async visible(actor: Actor, service: string | null) {
    return (
      !service ||
      can(actor, "incident.manage", service) ||
      (await hasServiceAccess(this.db, actor.id, service))
    );
  }
  async list(actor: Actor) {
    const result: any = {};
    for (const table of ["announcements", "incidents", "maintenance"]) {
      result[table] = [];
      for (const n of await this.db.query(
        `SELECT * FROM ${table} ORDER BY ${table === "maintenance" ? "starts_at" : "created_at"} DESC LIMIT 100`,
      ))
        if (await this.visible(actor, n.service_id)) {
          if (table === "incidents")
            n.updates = await this.db.query(
              "SELECT body,state,created_at FROM incident_updates WHERE incident_id=$1 ORDER BY created_at",
              [n.id],
            );
          result[table].push(n);
        }
    }
    return result;
  }
  async audience(
    db: any,
    service: string | null,
    kind: string,
    body: string,
    id: string,
  ) {
    const users = await db.query("SELECT id FROM users WHERE NOT suspended");
    for (const u of users)
      if (!service || (await hasServiceAccess(db, u.id, service)))
        await notify(db, u.id, kind, body, "/notices", `${kind}:${id}:${u.id}`);
  }
  async announce(actor: Actor, input: unknown) {
    const d = z
      .object({
        title: z.string().min(3).max(200),
        body: z.string().min(3).max(20000),
        serviceId: z.uuid().nullable().default(null),
      })
      .strict()
      .parse(input);
    requirePermission(actor, "incident.manage", d.serviceId ?? "*");
    return this.db.transaction(async (tx) => {
      const [n] = await tx.query(
        "INSERT INTO announcements(title,body,service_id,created_by) VALUES ($1,$2,$3,$4) RETURNING *",
        [d.title, d.body, d.serviceId, actor.id],
      );
      await audit(tx, actor.id, "announcement.create", n.id);
      await this.audience(
        tx,
        d.serviceId,
        "announcement",
        "A new community announcement is available.",
        n.id,
      );
      return n;
    });
  }
  async maintenance(actor: Actor, input: unknown) {
    const d = z
      .object({
        title: z.string().min(3).max(200),
        serviceId: z.uuid().nullable().default(null),
        startsAt: z.iso.datetime(),
        endsAt: z.iso.datetime(),
      })
      .strict()
      .parse(input);
    requirePermission(actor, "incident.manage", d.serviceId ?? "*");
    invariant(new Date(d.endsAt) > new Date(d.startsAt), "invalid_window");
    return this.db.transaction(async (tx) => {
      const [n] = await tx.query(
        "INSERT INTO maintenance(title,service_id,starts_at,ends_at,actor_id) VALUES ($1,$2,$3,$4,$5) RETURNING *",
        [d.title, d.serviceId, d.startsAt, d.endsAt, actor.id],
      );
      await audit(tx, actor.id, "maintenance.schedule", n.id, d);
      await this.audience(
        tx,
        d.serviceId,
        "maintenance",
        "Scheduled maintenance is available in the portal.",
        n.id,
      );
      return n;
    });
  }
  async incident(actor: Actor, input: unknown, id?: string) {
    const d = z
      .object({
        title: z.string().min(3).max(200),
        body: z.string().min(3).max(20000),
        state: z.enum([
          "investigating",
          "identified",
          "monitoring",
          "resolved",
        ]),
        serviceId: z.uuid().nullable().default(null),
      })
      .strict()
      .parse(input);
    return this.db.transaction(async (tx) => {
      let n;
      if (id) {
        [n] = await tx.query("SELECT * FROM incidents WHERE id=$1 FOR UPDATE", [
          id,
        ]);
        invariant(n, "not_found", 404);
        requirePermission(actor, "incident.manage", n.service_id ?? "*");
        [n] = await tx.query(
          "UPDATE incidents SET state=$1 WHERE id=$2 RETURNING *",
          [d.state, id],
        );
      } else {
        requirePermission(actor, "incident.manage", d.serviceId ?? "*");
        [n] = await tx.query(
          "INSERT INTO incidents(title,state,service_id,created_by) VALUES ($1,$2,$3,$4) RETURNING *",
          [d.title, d.state, d.serviceId, actor.id],
        );
      }
      const [update] = await tx.query(
        "INSERT INTO incident_updates(incident_id,actor_id,body,state) VALUES ($1,$2,$3,$4) RETURNING id",
        [n.id, actor.id, d.body, d.state],
      );
      await audit(tx, actor.id, "incident.update", n.id, { state: d.state });
      await this.audience(
        tx,
        n.service_id,
        "incident",
        "An incident update is available.",
        update.id,
      );
      return n;
    });
  }
  async changeMaintenance(actor: Actor, id: string, action: "start" | "end") {
    return this.db.transaction(async (tx) => {
      const [m] = await tx.query(
        "SELECT * FROM maintenance WHERE id=$1 FOR UPDATE",
        [id],
      );
      invariant(m, "not_found", 404);
      requirePermission(actor, "incident.manage", m.service_id ?? "*");
      if (action === "start") {
        invariant(
          new Date(m.ends_at).getTime() > Date.now(),
          "maintenance_already_ended",
        );
        await tx.query(
          "UPDATE maintenance SET starts_at=LEAST(starts_at,now()) WHERE id=$1",
          [id],
        );
      } else {
        // Ending a future window cancels it immediately instead of leaving a future
        // one-second maintenance interval that would still suppress alerts.
        await tx.query(
          "UPDATE maintenance SET starts_at=LEAST(starts_at,now()-interval '1 second'),ends_at=now() WHERE id=$1",
          [id],
        );
      }
      await audit(tx, actor.id, `maintenance.${action}`, id);
      await this.audience(
        tx,
        m.service_id,
        `maintenance-${action}`,
        `A maintenance window has ${action === "start" ? "started" : "ended"}.`,
        id,
      );
      return { ok: true };
    });
  }
}
