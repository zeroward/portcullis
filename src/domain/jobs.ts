import { randomUUID } from "node:crypto";
import type { Database } from "../db/index.js";
import { audit, enqueue, notify } from "./audit.js";
import { validGrant, effectiveBindings } from "./access.js";
import { ProviderError } from "../providers/http.js";
import type { PocketIdClient } from "../providers/pocket-id.js";
import type { NetBirdClient } from "../providers/netbird.js";
import type { WaygateClient } from "../providers/waygate.js";
export interface IntegrationClients {
  pocket?: PocketIdClient;
  netbird?: NetBirdClient;
  waygate?: WaygateClient;
  protectedPocketGroups?: string[];
}
export class Jobs {
  constructor(
    readonly db: Database,
    readonly clients: IntegrationClients,
  ) {}
  async maintenance() {
    const soon = await this.db.query(
      "SELECT id,user_id,expires_at FROM grants WHERE desired AND expires_at>now() AND expires_at<now()+interval '24 hours'",
    );
    for (const g of soon)
      await notify(
        this.db,
        g.user_id,
        "access-expiring",
        "Your access expires within 24 hours. Request renewal in My access.",
        "/access",
        `expiry-warning:${g.id}:${new Date(g.expires_at).toISOString()}`,
      );
    const expired = await this.db.query(
      "SELECT id,user_id FROM grants WHERE desired AND expires_at<=now()",
    );
    for (const g of expired)
      await this.db.transaction(async (tx) => {
        await tx.userLock(g.user_id);
        const [updated] = await tx.query(
          "UPDATE grants SET desired=false,version=version+1,fulfillment='revoking' WHERE id=$1 AND desired AND expires_at<=now() RETURNING *",
          [g.id],
        );
        if (updated) {
          await enqueue(
            tx,
            "reconcile-user",
            g.user_id,
            { grantId: g.id, version: updated.version },
            `expire:${g.id}:${updated.version}`,
            100,
          );
          await audit(tx, null, "grant.expire", g.id, {}, g.user_id);
        }
      });
    const due = await this.db.query(
      "SELECT id FROM health_checks WHERE enabled AND kind NOT IN ('manual','incoming') AND next_run<=now()",
    );
    for (const c of due)
      await this.db.transaction(async (tx) => {
        const [r] = await tx.query(
          "UPDATE health_checks SET next_run=now()+interval_seconds*interval '1 second'+random()*interval '10 seconds' WHERE id=$1 AND next_run<=now() RETURNING id",
          [c.id],
        );
        if (r)
          await enqueue(
            tx,
            "health",
            null,
            { checkId: c.id },
            `health:${c.id}:${Date.now()}`,
          );
      });
    const bucket = Math.floor(Date.now() / 300000);
    for (const u of await this.db.query(
      "SELECT id FROM users WHERE EXISTS(SELECT 1 FROM grants WHERE user_id=users.id)",
    ))
      await enqueue(
        this.db,
        "reconcile-user",
        u.id,
        {},
        `periodic:${u.id}:${bucket}`,
      );
    await this.db.query(
      "DELETE FROM oidc_flows WHERE expires_at<now(); DELETE FROM sessions WHERE expires_at<now() OR last_seen<now()-interval '30 minutes'; DELETE FROM webhook_nonces WHERE created_at<now()-interval '1 day'; DELETE FROM health_observations WHERE observed_at<now()-interval '90 days'; DELETE FROM jobs WHERE status='done' AND created_at<now()-interval '30 days'",
    );
  }
  async runOne(extra?: (kind: string, payload: any) => Promise<void>) {
    const lease = randomUUID();
    const [job] = await this.db.query(
      `UPDATE jobs SET status='running',attempts=attempts+1,lease_until=now()+interval '5 minutes',lease_token=$1 WHERE id=(SELECT id FROM jobs WHERE (status='queued' AND available_at<=now()) OR (status='running' AND lease_until<now()) ORDER BY priority DESC,available_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
      [lease],
    );
    if (!job) return false;
    try {
      if (job.kind === "reconcile-user")
        await this.reconcile(job.user_id, job.payload);
      else if (extra) await extra(job.kind, job.payload);
      else throw new Error("handler_unavailable");
      await this.db.query(
        "UPDATE jobs SET status='done',lease_until=NULL WHERE id=$1 AND lease_token=$2",
        [job.id, lease],
      );
    } catch (e) {
      const code = e instanceof ProviderError ? e.message : "operation_failed";
      const retry = e instanceof ProviderError ? e.retryable : true;
      await this.db.query(
        "UPDATE jobs SET status=$1,error=$2,available_at=now()+$3*interval '1 second',lease_until=NULL WHERE id=$4 AND lease_token=$5",
        [
          job.attempts >= 6 || !retry ? "failed" : "queued",
          code,
          Math.min(900, 2 ** job.attempts * 5),
          job.id,
          lease,
        ],
      );
    }
    return true;
  }
  async reconcile(user: string, payload: any = {}) {
    await this.db.withLock(`user:${user}`, async (db) => {
      if (payload.grantId) {
        const [g] = await db.query("SELECT version FROM grants WHERE id=$1", [
          payload.grantId,
        ]);
        if (!g || g.version !== payload.version) return;
      }
      const [u] = await db.query("SELECT * FROM users WHERE id=$1", [user]);
      if (!u) return;
      const grants = await db.query(
        "SELECT * FROM grants WHERE user_id=$1 ORDER BY created_at",
        [user],
      );
      const [run] = await db.query(
        "INSERT INTO reconciliation_runs(provider,status,details) VALUES ('managed-access','running',$1) RETURNING id",
        [JSON.stringify({ userId: user })],
      );
      let desired = effectiveBindings(u.suspended ? [] : grants);
      const all = new Map<string, any>();
      for (const g of grants)
        for (const b of g.snapshot.bindings ?? []) all.set(b.id, b);
      const failures: ProviderError[] = [];
      const drift: any[] = [];
      for (const b of all.values()) {
        const [currentUser] = await db.query(
          "SELECT suspended FROM users WHERE id=$1",
          [user],
        );
        const currentGrants = await db.query(
          "SELECT * FROM grants WHERE user_id=$1",
          [user],
        );
        desired = effectiveBindings(currentUser.suspended ? [] : currentGrants);
        const present = desired.some((d) => d.id === b.id);
        const activeSteps = await db.query(
          "SELECT s.* FROM fulfillment_steps s JOIN grants g ON g.id=s.grant_id WHERE g.user_id=$1 AND s.binding_id=$2 AND s.status='active' AND s.attested_by IS NOT NULL",
          [user, b.id],
        );
        try {
          if (["manual", "wow-manager"].includes(b.provider)) {
            if (present && activeSteps.length) {
              await db.query(
                "UPDATE fulfillment_steps SET status='active',error=NULL,attested_by=$1,attested_at=$2,observed=$3 WHERE binding_id=$4 AND grant_id IN(SELECT id FROM grants WHERE user_id=$5)",
                [
                  activeSteps[0].attested_by,
                  activeSteps[0].attested_at,
                  JSON.stringify({
                    manualAttestation: "Retained existing attested fulfillment",
                    sourceStepId: activeSteps[0].id,
                  }),
                  b.id,
                  user,
                ],
              );
              continue;
            }
            if (
              !present &&
              !(
                await db.query(
                  "SELECT 1 FROM fulfillment_steps s JOIN grants g ON g.id=s.grant_id WHERE g.user_id=$1 AND s.binding_id=$2 AND s.attested_by IS NOT NULL",
                  [user, b.id],
                )
              ).length
            ) {
              await db.query(
                "UPDATE fulfillment_steps SET status='revoked',error=NULL WHERE binding_id=$1 AND grant_id IN(SELECT id FROM grants WHERE user_id=$2)",
                [b.id, user],
              );
              continue;
            }
            await db.query(
              "UPDATE fulfillment_steps SET status=$1,error=$2 WHERE binding_id=$3 AND grant_id IN(SELECT id FROM grants WHERE user_id=$4)",
              [
                present ? "blocked" : "revocation-failed",
                present
                  ? b.provider === "wow-manager"
                    ? "Awaiting API specification; manual attestation available"
                    : "Manual fulfillment required"
                  : "Manual removal attestation required",
                b.id,
                user,
              ],
            );
            continue;
          }
          if (b.provider === "mock")
            throw new ProviderError("forbidden", "mock");
          const provider = b.provider as "pocket-id" | "netbird";
          let observed: any = {
            controlPlaneVerified: true,
            trafficVerified: false,
            desiredPresent: present,
            observedAt: new Date().toISOString(),
          };
          const [link] = await db.query(
            "SELECT external_id FROM identity_links WHERE user_id=$1 AND provider=$2",
            [user, provider],
          );
          if (!link) throw new ProviderError("unavailable", provider, false);
          if (!b.managed) throw new ProviderError("forbidden", provider);
          if (provider === "pocket-id") {
            if (!this.clients.pocket)
              throw new ProviderError("missing-credentials", provider);
            await this.db.withLock(
              `pocket-group:${b.external_id}`,
              async () => {
                const [edge] = await db.query(
                  "SELECT * FROM managed_edges WHERE provider=$1 AND resource_id=$2 AND subject_id=$3",
                  [provider, b.external_id, link.external_id],
                );
                if (present) {
                  const observedGroup = await this.clients.pocket!.group(
                    b.external_id,
                  );
                  if (
                    this.clients.protectedPocketGroups?.includes(
                      observedGroup.name,
                    )
                  )
                    throw new ProviderError("forbidden", "pocket-id");
                  if (!edge) {
                    const group = await this.clients.pocket!.group(
                      b.external_id,
                    );
                    const exists = group.users.some(
                      (g) => g.id === link.external_id,
                    );
                    await db.query(
                      "INSERT INTO managed_edges(provider,resource_id,subject_id,added) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
                      [provider, b.external_id, link.external_id, !exists],
                    );
                  }
                  const result = await this.clients.pocket!.setMembership(
                    b.external_id,
                    link.external_id,
                    true,
                  );
                  observed = {
                    ...observed,
                    changed: !result.previouslyPresent,
                    observedMembershipPresent: true,
                  };
                } else if (
                  edge?.added &&
                  !desired.some(
                    (d) =>
                      d.provider === provider &&
                      d.external_id === b.external_id,
                  )
                ) {
                  const result = await this.clients.pocket!.setMembership(
                    b.external_id,
                    link.external_id,
                    false,
                  );
                  observed = {
                    ...observed,
                    changed: result.previouslyPresent,
                    observedMembershipPresent: false,
                  };
                  await db.query(
                    "DELETE FROM managed_edges WHERE provider=$1 AND resource_id=$2 AND subject_id=$3",
                    [provider, b.external_id, link.external_id],
                  );
                } else {
                  const group = await this.clients.pocket!.group(b.external_id);
                  const stillPresent = group.users.some(
                    (u) => u.id === link.external_id,
                  );
                  observed = {
                    ...observed,
                    changed: false,
                    observedMembershipPresent: stillPresent,
                    retainedByOtherGrant: desired.some(
                      (d) =>
                        d.provider === provider &&
                        d.external_id === b.external_id,
                    ),
                    unmanagedMembershipRetained: stillPresent && !edge?.added,
                  };
                }
              },
            );
          } else {
            if (!this.clients.netbird)
              throw new ProviderError("missing-credentials", provider);
            const resourceStillDesired = desired.some(
              (d) => d.provider === provider && d.external_id === b.external_id,
            );
            observed = {
              ...observed,
              ...(await this.clients.netbird.access(
                db,
                this.db,
                link.external_id,
                b.external_id,
                present || resourceStillDesired,
              )),
              retainedByOtherGrant: !present && resourceStillDesired,
            };
          }
          await db.query(
            "UPDATE fulfillment_steps SET status=$1,error=NULL,observed=$2 WHERE binding_id=$3 AND grant_id IN(SELECT id FROM grants WHERE user_id=$4)",
            [
              present ? "active" : "revoked",
              JSON.stringify(observed),
              b.id,
              user,
            ],
          );
          if (observed.changed)
            drift.push({
              bindingId: b.id,
              provider,
              desiredPresent: present,
              repaired: true,
            });
          await audit(
            db,
            null,
            present ? "provider.grant" : "provider.revoke",
            b.id,
            { provider, ...observed },
            user,
          );
        } catch (e) {
          const error =
            e instanceof ProviderError
              ? e
              : new ProviderError("unavailable", b.provider, true);
          failures.push(error);
          await db.query(
            "UPDATE fulfillment_steps SET status=$1,error=$2 WHERE binding_id=$3 AND grant_id IN(SELECT id FROM grants WHERE user_id=$4)",
            [
              present ? "partially-failed" : "revocation-failed",
              error.message,
              b.id,
              user,
            ],
          );
          await audit(
            db,
            null,
            "provider.write",
            b.id,
            { error: error.code },
            user,
            "failure",
          );
        }
      }
      const [latestUser] = await db.query(
        "SELECT suspended FROM users WHERE id=$1",
        [user],
      );
      const latestGrants = await db.query(
        "SELECT * FROM grants WHERE user_id=$1",
        [user],
      );
      const latestDesired = effectiveBindings(
        latestUser.suspended ? [] : latestGrants,
      );
      for (const g of latestGrants) {
        if (grants.find((old) => old.id === g.id)?.version !== g.version)
          continue;
        const steps = await db.query(
          "SELECT * FROM fulfillment_steps WHERE grant_id=$1",
          [g.id],
        );
        const wants = validGrant(g) && !latestUser.suspended;
        const status = wants
          ? steps.some((s) => s.status === "partially-failed")
            ? "partially-failed"
            : steps.some((s) => s.status !== "active")
              ? "blocked"
              : "active"
          : steps.some(
                (s) =>
                  s.status === "active" &&
                  !latestDesired.some((b) => b.id === s.binding_id),
              )
            ? "revoking"
            : steps.some((s) => !["revoked", "active"].includes(s.status))
              ? "revocation-failed"
              : "revoked";
        await db.query(
          "UPDATE grants SET fulfillment=$1 WHERE id=$2 AND version=$3",
          [status, g.id, g.version],
        );
        if (status === "revoking")
          await enqueue(
            db,
            "reconcile-user",
            user,
            { grantId: g.id, version: g.version },
            `delayed-removal:${g.id}:${g.version}:${Date.now()}`,
            100,
          );
        if (
          status !== g.fulfillment &&
          [
            "active",
            "partially-failed",
            "revocation-failed",
            "blocked",
          ].includes(status)
        )
          await notify(
            db,
            user,
            "fulfillment",
            `Your access fulfillment is ${status}.`,
            "/access",
            `fulfillment:${g.id}:${g.version}:${status}`,
          );
      }
      await db.query(
        "UPDATE reconciliation_runs SET status=$1,finished_at=now(),details=$2 WHERE id=$3",
        [
          failures.length ? "failed" : "complete",
          JSON.stringify({
            userId: user,
            bindings: all.size,
            drift,
            failures: failures.map((e) => ({
              provider: e.provider,
              code: e.code,
            })),
            trafficVerified: false,
          }),
          run.id,
        ],
      );
      if (failures.length) throw failures[0];
    });
  }
}
