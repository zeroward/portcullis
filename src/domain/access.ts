import { z } from "zod";
import type { Database, Queryable, Transaction } from "../db/index.js";
import {
  can,
  requirePermission,
  requireFresh,
  invalidate,
  type Actor,
} from "./authorization.js";
import { audit, enqueue, notify } from "./audit.js";
import { invariant } from "../errors.js";
import { stableJson } from "../security.js";
export const entitlementInput = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9.-]{2,100}$/),
    name: z.string().min(2).max(100),
    policy: z
      .object({
        description: z.string().max(2000).default(""),
        requestable: z.boolean().default(false),
        approvals: z.number().int().min(1).max(3).default(1),
        noSelfApproval: z.boolean().default(true),
        maxHours: z.number().int().min(1).max(8760).default(720),
        defaultHours: z.number().int().min(1).max(8760).default(168),
        requiredGuides: z.array(z.uuid()).default([]),
        renewable: z.boolean().default(true),
      })
      .strict(),
    prerequisites: z.array(z.uuid()).default([]),
    version: z.number().int().optional(),
  })
  .strict();
export function validGrant(g: any, now = new Date()) {
  return g.desired && (!g.expires_at || new Date(g.expires_at) > now);
}
export function effectiveBindings(grants: any[], now = new Date()) {
  const map = new Map<string, any>();
  for (const g of grants.filter((g) => validGrant(g, now)))
    for (const b of g.snapshot.bindings ?? []) map.set(b.id, b);
  return [...map.values()];
}
export class Access {
  constructor(readonly db: Database) {}
  async list() {
    return this.db.query("SELECT * FROM entitlements ORDER BY name");
  }
  async configuration(actor: Actor) {
    requirePermission(actor, "access.manage");
    const entitlements = await this.list();
    for (const e of entitlements) {
      e.prerequisites = (
        await this.db.query(
          "SELECT prerequisite_id FROM prerequisites WHERE entitlement_id=$1",
          [e.id],
        )
      ).map((p) => p.prerequisite_id);
      e.bindings = await this.db.query(
        "SELECT * FROM bindings WHERE entitlement_id=$1",
        [e.id],
      );
    }
    const bundles = await this.db.query("SELECT * FROM bundles ORDER BY name");
    for (const b of bundles)
      b.entitlementIds = (
        await this.db.query(
          "SELECT entitlement_id FROM bundle_items WHERE bundle_id=$1",
          [b.id],
        )
      ).map((e) => e.entitlement_id);
    return { entitlements, bundles };
  }
  async save(actor: Actor, input: unknown, id?: string) {
    requirePermission(actor, "access.manage");
    const data = entitlementInput.parse(input);
    invariant(
      data.policy.defaultHours <= data.policy.maxHours,
      "invalid_duration",
    );
    return this.db.transaction(async (tx) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtext('entitlement-prerequisites'))",
      );
      let row;
      if (id) {
        [row] = await tx.query(
          "UPDATE entitlements SET key=$1,name=$2,policy=$3,version=version+1 WHERE id=$4 AND version=$5 RETURNING *",
          [data.key, data.name, JSON.stringify(data.policy), id, data.version],
        );
        invariant(row, "version_conflict", 409);
      } else
        [row] = await tx.query(
          "INSERT INTO entitlements(key,name,policy) VALUES ($1,$2,$3) RETURNING *",
          [data.key, data.name, JSON.stringify(data.policy)],
        );
      await tx.query("DELETE FROM prerequisites WHERE entitlement_id=$1", [
        row.id,
      ]);
      for (const p of data.prerequisites)
        await tx.query("INSERT INTO prerequisites VALUES ($1,$2)", [row.id, p]);
      const cycle = await tx.query(
        `WITH RECURSIVE walk(node,path,cycle) AS (SELECT prerequisite_id,ARRAY[entitlement_id,prerequisite_id],entitlement_id=prerequisite_id FROM prerequisites WHERE entitlement_id=$1 UNION ALL SELECT p.prerequisite_id,w.path||p.prerequisite_id,p.prerequisite_id=ANY(w.path) FROM walk w JOIN prerequisites p ON p.entitlement_id=w.node WHERE NOT w.cycle) SELECT 1 FROM walk WHERE cycle LIMIT 1`,
        [row.id],
      );
      invariant(!cycle.length, "prerequisite_cycle");
      await audit(tx, actor.id, "entitlement.save", row.id, data);
      return row;
    });
  }
  async prerequisites(db: Queryable, user: string, entitlement: any) {
    const missing = await db.query(
      `SELECT p.prerequisite_id FROM prerequisites p WHERE p.entitlement_id=$1 AND NOT EXISTS (SELECT 1 FROM grants g WHERE g.user_id=$2 AND g.entitlement_id=p.prerequisite_id AND g.desired AND g.fulfillment='active' AND (g.expires_at IS NULL OR g.expires_at>now()))`,
      [entitlement.id, user],
    );
    invariant(!missing.length, "missing_prerequisites", 409);
    for (const id of entitlement.policy.requiredGuides ?? []) {
      const accepted = await db.query(
        "SELECT 1 FROM guides g JOIN acknowledgments a ON a.guide_id=g.id AND a.version=g.current_version WHERE g.id=$1 AND a.user_id=$2",
        [id, user],
      );
      invariant(accepted.length, "required_acknowledgment", 409);
    }
  }
  async snapshot(
    db: Queryable,
    ids: string[],
    user: string,
    requestable: boolean,
  ) {
    const items = [];
    for (const id of [...new Set(ids)]) {
      const [e] = await db.query("SELECT * FROM entitlements WHERE id=$1", [
        id,
      ]);
      invariant(e, "entitlement_not_found", 404);
      if (requestable) invariant(e.policy.requestable, "not_requestable", 403);
      await this.prerequisites(db, user, e);
      const bindings = await db.query(
        "SELECT * FROM bindings WHERE entitlement_id=$1 ORDER BY id",
        [id],
      );
      items.push({ ...e, bindings });
    }
    invariant(items.length, "empty_request");
    return items;
  }
  async request(actor: Actor, input: unknown) {
    const d = z
      .object({
        entitlementId: z.uuid().optional(),
        bundleId: z.uuid().optional(),
        reason: z.string().min(5).max(4000),
        durationHours: z.number().int().min(1).max(8760),
      })
      .strict()
      .parse(input);
    invariant(!!d.entitlementId !== !!d.bundleId, "select_one_target");
    return this.db.transaction(async (tx) => {
      await tx.userLock(actor.id);
      let ids = d.entitlementId ? [d.entitlementId] : [];
      let bundle: any;
      if (d.bundleId) {
        [bundle] = await tx.query("SELECT * FROM bundles WHERE id=$1", [
          d.bundleId,
        ]);
        invariant(bundle?.requestable, "not_requestable", 403);
        ids = (
          await tx.query(
            "SELECT entitlement_id FROM bundle_items WHERE bundle_id=$1",
            [d.bundleId],
          )
        ).map((r) => r.entitlement_id);
      }
      const items = await this.snapshot(tx, ids, actor.id, true);
      invariant(
        items.every((e) => d.durationHours <= e.policy.maxHours),
        "duration_exceeds_policy",
      );
      const [ticket] = await tx.query(
        "INSERT INTO tickets(requester_id,type,subject,description) VALUES ($1,'access request',$2,$3) RETURNING *",
        [actor.id, `Access: ${bundle?.name ?? items[0].name}`, d.reason],
      );
      const [r] = await tx.query(
        "INSERT INTO access_requests(user_id,ticket_id,snapshot,duration_hours,reason) VALUES ($1,$2,$3,$4,$5) RETURNING *",
        [
          actor.id,
          ticket.id,
          JSON.stringify({
            items,
            bundle: bundle ? { id: bundle.id, version: bundle.version } : null,
          }),
          d.durationHours,
          d.reason,
        ],
      );
      await audit(tx, actor.id, "access.request", r.id, {
        durationHours: d.durationHours,
        entitlements: ids,
      });
      return r;
    });
  }
  async approvalPermission(actor: Actor, db: Queryable, entitlement: string) {
    const services = await db.query(
      "SELECT service_id FROM service_entitlements WHERE entitlement_id=$1",
      [entitlement],
    );
    if (!services.length) requirePermission(actor, "access.decide");
    else
      for (const s of services)
        requirePermission(actor, "access.decide", s.service_id);
  }
  async decide(actor: Actor, id: string, input: unknown) {
    const d = z
      .object({
        decision: z.enum(["approved", "denied", "needs-information"]),
        reason: z.string().min(3).max(4000),
        durationHours: z.number().int().min(1).optional(),
        confirmation: z.literal("APPROVE").optional(),
      })
      .strict()
      .parse(input);
    if (d.decision === "approved")
      requireFresh(actor, d.confirmation ?? "", "APPROVE");
    return this.db.transaction(async (tx) => {
      const [peek] = await tx.query(
        "SELECT user_id FROM access_requests WHERE id=$1",
        [id],
      );
      invariant(peek, "not_found", 404);
      await tx.userLock(peek.user_id);
      const [r] = await tx.query(
        "SELECT * FROM access_requests WHERE id=$1 FOR UPDATE",
        [id],
      );
      invariant(
        ["pending", "needs-information"].includes(r.status),
        "request_closed",
        409,
      );
      const currentRoles = await tx.query(
        "SELECT role,scope FROM roles WHERE user_id=$1",
        [actor.id],
      );
      const current = { ...actor, roles: currentRoles };
      for (const e of r.snapshot.items) {
        await this.approvalPermission(current, tx, e.id);
        invariant(
          !e.policy.noSelfApproval || r.user_id !== actor.id,
          "self_approval_forbidden",
          403,
        );
      }
      if (d.decision === "approved") {
        const fresh = await this.snapshot(
          tx,
          r.snapshot.items.map((e: any) => e.id),
          r.user_id,
          true,
        );
        invariant(
          fresh.every((e) =>
            r.snapshot.items.some(
              (s: any) =>
                s.id === e.id &&
                s.version === e.version &&
                stableJson(s.bindings) === stableJson(e.bindings),
            ),
          ),
          "request_snapshot_stale",
          409,
        );
        if (r.snapshot.bundle) {
          const [b] = await tx.query(
            "SELECT version FROM bundles WHERE id=$1",
            [r.snapshot.bundle.id],
          );
          invariant(
            b?.version === r.snapshot.bundle.version,
            "request_snapshot_stale",
            409,
          );
        }
        invariant(
          !d.durationHours || d.durationHours <= r.duration_hours,
          "cannot_expand_approval",
        );
      }
      const [decision] = await tx.query(
        "INSERT INTO decisions(request_id,actor_id,decision,reason,duration_hours) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id",
        [
          id,
          actor.id,
          d.decision,
          d.reason,
          d.durationHours ?? r.duration_hours,
        ],
      );
      invariant(decision, "duplicate_approver", 409);
      let status = d.decision;
      if (d.decision === "approved") {
        const decisions = await tx.query(
          "SELECT * FROM decisions WHERE request_id=$1 AND decision='approved'",
          [id],
        );
        const needed = Math.max(
          ...r.snapshot.items.map((e: any) => e.policy.approvals ?? 1),
        );
        // Old decisions no longer count if an approver lost permission.
        let eligible = 0;
        for (const a of decisions) {
          const [u] = await tx.query(
            "SELECT suspended FROM users WHERE id=$1",
            [a.actor_id],
          );
          const roles = await tx.query(
            "SELECT role,scope FROM roles WHERE user_id=$1",
            [a.actor_id],
          );
          try {
            invariant(u && !u.suspended, "forbidden", 403);
            for (const e of r.snapshot.items)
              await this.approvalPermission(
                { ...actor, id: a.actor_id, roles },
                tx,
                e.id,
              );
            eligible++;
          } catch {
            /* No longer eligible. */
          }
        }
        if (eligible < needed) status = "pending" as any;
        else {
          const duration = Math.min(
            ...decisions.map((a) => a.duration_hours),
            r.duration_hours,
          );
          for (const e of r.snapshot.items)
            await this.createGrant(
              tx,
              actor,
              r.user_id,
              e,
              `request:${id}`,
              duration,
              id,
            );
        }
      }
      await tx.query(
        "UPDATE access_requests SET status=$1,version=version+1 WHERE id=$2",
        [status, id],
      );
      await tx.query(
        "INSERT INTO ticket_comments(ticket_id,author_id,body) VALUES ($1,$2,$3)",
        [r.ticket_id, actor.id, `${d.decision}: ${d.reason}`],
      );
      await audit(
        tx,
        actor.id,
        "access.decide",
        id,
        { ...d, result: status },
        r.user_id,
      );
      await notify(
        tx,
        r.user_id,
        "access-decision",
        `Your access request is ${status}.`,
        "/access",
        `decision:${decision.id}`,
      );
      return { status, fulfillment: status === "approved" ? "queued" : null };
    });
  }
  async createGrant(
    tx: Transaction,
    actor: Actor,
    user: string,
    e: any,
    source: string,
    hours: number,
    request: string | null = null,
  ) {
    const [g] = await tx.query(
      "INSERT INTO grants(user_id,entitlement_id,request_id,source,expires_at,snapshot) VALUES ($1,$2,$3,$4,now()+$5*interval '1 hour',$6) RETURNING *",
      [user, e.id, request, source, hours, JSON.stringify(e)],
    );
    for (const b of e.bindings)
      await tx.query(
        "INSERT INTO fulfillment_steps(grant_id,binding_id) VALUES ($1,$2)",
        [g.id, b.id],
      );
    await enqueue(
      tx,
      "reconcile-user",
      user,
      { grantId: g.id, version: g.version },
      `grant:${g.id}:${g.version}`,
    );
    await audit(
      tx,
      actor.id,
      "grant.create",
      g.id,
      { source, entitlement: e.key, hours },
      user,
    );
    return g;
  }
  async grant(actor: Actor, input: unknown) {
    requirePermission(actor, "access.manage");
    const d = z
      .object({
        userId: z.uuid(),
        entitlementId: z.uuid(),
        durationHours: z.number().int().min(1).max(8760),
        reason: z.string().min(5).max(4000),
      })
      .strict()
      .parse(input);
    return this.db.transaction(async (tx) => {
      await tx.userLock(d.userId);
      const [e] = await this.snapshot(tx, [d.entitlementId], d.userId, false);
      invariant(
        d.durationHours <= e.policy.maxHours,
        "duration_exceeds_policy",
      );
      return this.createGrant(
        tx,
        actor,
        d.userId,
        e,
        `admin:${d.reason}`,
        d.durationHours,
      );
    });
  }
  async revoke(actor: Actor, id: string) {
    requirePermission(actor, "access.manage");
    return this.db.transaction(async (tx) => {
      const [g] = await tx.query("SELECT * FROM grants WHERE id=$1", [id]);
      invariant(g, "not_found", 404);
      await tx.query(
        "UPDATE grants SET desired=false,version=version+1,fulfillment='revoking' WHERE id=$1",
        [id],
      );
      await enqueue(
        tx,
        "reconcile-user",
        g.user_id,
        { grantId: id, version: g.version + 1 },
        `revoke:${id}:${g.version + 1}`,
        100,
      );
      await audit(tx, actor.id, "grant.revoke", id, {}, g.user_id);
      return { desired: false, fulfillment: "revoking" };
    });
  }
  async renew(actor: Actor, id: string, hours: number) {
    const [g] = await this.db.query("SELECT * FROM grants WHERE id=$1", [id]);
    invariant(g, "not_found", 404);
    invariant(
      g.user_id === actor.id || can(actor, "access.manage"),
      "forbidden",
      403,
    );
    invariant(g.snapshot.policy.renewable !== false, "renewal_forbidden");
    return this.request(
      { ...actor, id: g.user_id },
      {
        entitlementId: g.entitlement_id,
        reason: `Renewal of ${id}`,
        durationHours: hours,
      },
    );
  }
  async mine(actor: Actor) {
    const project = (snapshot: any) => ({
      id: snapshot.id,
      key: snapshot.key,
      name: snapshot.name,
      version: snapshot.version,
      policy: snapshot.policy,
    });
    const grants = await this.db.query(
      "SELECT g.*,e.name,e.key FROM grants g JOIN entitlements e ON e.id=g.entitlement_id WHERE g.user_id=$1 ORDER BY g.created_at DESC",
      [actor.id],
    );
    const requests = await this.db.query(
      "SELECT * FROM access_requests WHERE user_id=$1 ORDER BY created_at DESC",
      [actor.id],
    );
    return {
      grants: grants.map((g) => ({ ...g, snapshot: project(g.snapshot) })),
      requests: requests.map((r) => ({
        ...r,
        snapshot: {
          items: r.snapshot.items.map(project),
          bundle: r.snapshot.bundle,
        },
      })),
      steps: await this.db.query(
        "SELECT s.* FROM fulfillment_steps s JOIN grants g ON g.id=s.grant_id WHERE g.user_id=$1",
        [actor.id],
      ),
    };
  }
  async attest(actor: Actor, stepId: string, reason: string) {
    requirePermission(actor, "access.manage");
    invariant(reason.length >= 5, "reason_required");
    await this.db.transaction(async (tx) => {
      const [s] = await tx.query(
        "SELECT s.*,g.user_id FROM fulfillment_steps s JOIN grants g ON g.id=s.grant_id WHERE s.id=$1",
        [stepId],
      );
      invariant(s, "not_found", 404);
      await tx.userLock(s.user_id);
      const [g] = await tx.query("SELECT * FROM grants WHERE id=$1", [
        s.grant_id,
      ]);
      invariant(validGrant(g), "grant_not_desired", 409);
      const b = g.snapshot.bindings.find((b: any) => b.id === s.binding_id);
      invariant(["manual", "wow-manager"].includes(b?.provider), "not_manual");
      await tx.query(
        "UPDATE fulfillment_steps SET status='active',attested_by=$1,attested_at=now(),observed=$2,error=NULL WHERE id=$3",
        [actor.id, JSON.stringify({ manualAttestation: reason }), stepId],
      );
      await audit(
        tx,
        actor.id,
        "fulfillment.attest",
        stepId,
        { reason },
        g.user_id,
      );
      await enqueue(
        tx,
        "reconcile-user",
        g.user_id,
        { grantId: g.id, version: g.version },
        `attest:${stepId}:${Date.now()}`,
      );
    });
  }
  async suspend(actor: Actor, user: string, suspended: boolean) {
    requirePermission(actor, "identity.manage");
    invariant(actor.id !== user, "cannot_suspend_self");
    await this.db.transaction(async (tx) => {
      await tx.query("UPDATE users SET suspended=$1 WHERE id=$2", [
        suspended,
        user,
      ]);
      await invalidate(tx, user);
      await enqueue(
        tx,
        "reconcile-user",
        user,
        {},
        `suspend:${user}:${Date.now()}`,
        100,
      );
      await audit(tx, actor.id, "portal.suspend", user, { suspended }, user);
    });
  }
}
