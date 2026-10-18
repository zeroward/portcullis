import { z } from "zod";
import type { Database } from "../db/index.js";
import { can, requirePermission, type Actor } from "./authorization.js";
import { invariant } from "../errors.js";
import { audit, notify } from "./audit.js";
import { Catalog } from "./catalog.js";
export class Tickets {
  constructor(
    readonly db: Database,
    readonly catalog: Catalog,
  ) {}
  staff(actor: Actor, service: string | null) {
    return can(actor, "ticket.staff", service ?? "*");
  }
  async visible(actor: Actor, id: string) {
    const [t] = await this.db.query("SELECT * FROM tickets WHERE id=$1", [id]);
    invariant(t, "not_found", 404);
    invariant(
      t.requester_id === actor.id || this.staff(actor, t.service_id),
      "not_found",
      404,
    );
    return t;
  }
  async list(actor: Actor) {
    const rows = await this.db.query(
      "SELECT * FROM tickets ORDER BY updated_at DESC LIMIT 500",
    );
    return rows.filter(
      (t) => t.requester_id === actor.id || this.staff(actor, t.service_id),
    );
  }
  async detail(actor: Actor, id: string) {
    const t = await this.visible(actor, id);
    const staff = this.staff(actor, t.service_id);
    const comments = await this.db.query(
      "SELECT c.*,u.name AS author FROM ticket_comments c JOIN users u ON u.id=c.author_id WHERE ticket_id=$1 AND (NOT private OR $2) ORDER BY created_at",
      [id, staff],
    );
    const attachments = await this.db.query(
      "SELECT id,name,mime,size FROM attachments WHERE ticket_id=$1",
      [id],
    );
    return { ...t, comments, attachments, canStaff: staff };
  }
  async create(actor: Actor, input: unknown) {
    const d = z
      .object({
        subject: z.string().min(3).max(200),
        description: z.string().min(5).max(20000),
        type: z.enum([
          "access request",
          "technical problem",
          "new game request",
          "server problem",
          "feature request",
          "account problem",
        ]),
        priority: z.enum(["low", "normal", "high"]).default("normal"),
        serviceId: z.uuid().nullable().optional(),
      })
      .strict()
      .parse(input);
    if (d.serviceId) await this.catalog.detail(actor, d.serviceId);
    return this.db.transaction(async (tx) => {
      const [t] = await tx.query(
        "INSERT INTO tickets(requester_id,service_id,type,subject,description,priority) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
        [
          actor.id,
          d.serviceId ?? null,
          d.type,
          d.subject,
          d.description,
          d.priority,
        ],
      );
      await audit(tx, actor.id, "ticket.create", t.id);
      return t;
    });
  }
  async comment(actor: Actor, id: string, input: unknown) {
    const t = await this.visible(actor, id);
    const d = z
      .object({
        body: z.string().min(1).max(20000),
        private: z.boolean().default(false),
      })
      .strict()
      .parse(input);
    if (d.private)
      requirePermission(actor, "ticket.staff", t.service_id ?? "*");
    return this.db.transaction(async (tx) => {
      const [c] = await tx.query(
        "INSERT INTO ticket_comments(ticket_id,author_id,body,private) VALUES ($1,$2,$3,$4) RETURNING *",
        [id, actor.id, d.body, d.private],
      );
      await tx.query("UPDATE tickets SET updated_at=now() WHERE id=$1", [id]);
      await audit(tx, actor.id, d.private ? "ticket.note" : "ticket.reply", id);
      if (!d.private && t.requester_id !== actor.id)
        await notify(
          tx,
          t.requester_id,
          "ticket-reply",
          "Your ticket has a new reply.",
          "/tickets",
          `reply:${c.id}`,
        );
      return c;
    });
  }
  async update(actor: Actor, id: string, input: unknown) {
    const t = await this.visible(actor, id);
    const d = z
      .object({
        status: z
          .enum([
            "open",
            "in-progress",
            "needs-information",
            "resolved",
            "closed",
          ])
          .optional(),
        assigneeId: z.uuid().nullable().optional(),
      })
      .strict()
      .parse(input);
    if (!this.staff(actor, t.service_id))
      invariant(
        d.status === "open" && d.assigneeId === undefined,
        "forbidden",
        403,
      );
    return this.db.transaction(async (tx) => {
      const [row] = await tx.query(
        "UPDATE tickets SET status=COALESCE($1,status),assignee_id=CASE WHEN $2 THEN $3 ELSE assignee_id END,updated_at=now() WHERE id=$4 RETURNING *",
        [
          d.status ?? null,
          d.assigneeId !== undefined,
          d.assigneeId ?? null,
          id,
        ],
      );
      await audit(tx, actor.id, "ticket.update", id, d);
      return row;
    });
  }
}
