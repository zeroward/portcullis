import { z } from "zod";
import type { Database } from "../db/index.js";
import type { Config } from "../config.js";
import type { IntegrationClients } from "./jobs.js";
import type { Actor } from "./authorization.js";
import {
  requirePermission,
  requireFresh,
  invalidate,
} from "./authorization.js";
import { invariant } from "../errors.js";
import { audit, enqueue } from "./audit.js";
import { encrypt, decrypt } from "../security.js";
import { healthSummary } from "./catalog.js";
export class Admin {
  constructor(
    readonly db: Database,
    readonly config: Config,
    readonly clients: IntegrationClients,
  ) {}
  async summary(actor: Actor) {
    requirePermission(actor, "*");
    const health = [];
    for (const service of await this.db.query(
      "SELECT id,name FROM services ORDER BY name",
    )) {
      health.push({
        ...service,
        ...(await healthSummary(this.db, service.id)),
      });
    }
    return {
      health,
      incidents: await this.db.query(
        "SELECT * FROM incidents WHERE state<>'resolved' ORDER BY created_at DESC",
      ),
      tickets: await this.db.query(
        "SELECT id,subject,status,priority,assignee_id FROM tickets WHERE status NOT IN ('closed','resolved') ORDER BY updated_at DESC LIMIT 100",
      ),
      requests: await this.db.query(
        "SELECT r.*,u.name FROM access_requests r JOIN users u ON u.id=r.user_id WHERE r.status IN('pending','needs-information') ORDER BY r.created_at",
      ),
      failures: await this.db.query(
        "SELECT g.*,u.name FROM grants g JOIN users u ON u.id=g.user_id WHERE fulfillment IN ('partially-failed','blocked','revocation-failed')",
      ),
      expiring: await this.db.query(
        "SELECT g.*,u.name FROM grants g JOIN users u ON u.id=g.user_id WHERE desired AND expires_at<now()+interval '7 days'",
      ),
      workers: await this.db.query("SELECT * FROM worker_heartbeats"),
      jobs: await this.db.query(
        "SELECT * FROM jobs WHERE status='failed' ORDER BY created_at DESC LIMIT 100",
      ),
      reconciliation: await this.db.query(
        "SELECT * FROM reconciliation_runs ORDER BY started_at DESC LIMIT 20",
      ),
      audit: await this.db.query(
        "SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 30",
      ),
      devices: await this.db.query(
        "SELECT * FROM devices ORDER BY observed_at DESC LIMIT 30",
      ),
      providers: {
        pocketId: {
          configured: !!this.clients.pocket,
          version: this.config.POCKET_ID_VERSION,
          liveVerified: false,
        },
        netbird: {
          configured: !!this.clients.netbird,
          version: this.config.NETBIRD_VERSION,
          liveVerified: false,
        },
        waygate: {
          configured: !!this.clients.waygate?.isConfigured(),
          version: this.config.WAYGATE_VERSION,
          liveVerified: false,
        },
      },
    };
  }
  async link(actor: Actor, input: unknown) {
    const d = z
      .object({
        userId: z.uuid(),
        provider: z.enum(["pocket-id", "netbird"]),
        externalId: z.string().min(1).max(255),
        confirmation: z.literal("LINK"),
        reason: z.string().min(5).max(2000),
      })
      .strict()
      .parse(input);
    requirePermission(
      actor,
      d.provider === "pocket-id" ? "identity.manage" : "network.manage",
    );
    requireFresh(actor, d.confirmation, "LINK");
    if (d.provider === "pocket-id") {
      invariant(this.clients.pocket, "provider_not_configured", 503);
      await this.clients.pocket.user(d.externalId);
    } else {
      invariant(this.clients.netbird, "provider_not_configured", 503);
      invariant(
        (await this.clients.netbird.users()).some((u) => u.id === d.externalId),
        "provider_user_not_found",
      );
    }
    return this.db.transaction(async (tx) => {
      await tx.userLock(d.userId);
      invariant(
        !(
          await tx.query(
            "SELECT 1 FROM identity_links WHERE user_id=$1 AND provider=$2",
            [d.userId, d.provider],
          )
        ).length,
        "link_already_exists",
        409,
      );
      await tx.query(
        "INSERT INTO identity_links(user_id,provider,external_id,verified_by) VALUES ($1,$2,$3,$4)",
        [d.userId, d.provider, d.externalId, actor.id],
      );
      await audit(
        tx,
        actor.id,
        "identity.link",
        d.userId,
        { provider: d.provider, externalId: d.externalId, reason: d.reason },
        d.userId,
      );
      await enqueue(
        tx,
        "reconcile-user",
        d.userId,
        {},
        `link:${d.userId}:${d.provider}:${Date.now()}`,
      );
      return { verified: true };
    });
  }
  async binding(actor: Actor, input: unknown) {
    requirePermission(actor, "access.manage");
    const d = z
      .object({
        entitlementId: z.uuid(),
        provider: z.enum(["pocket-id", "netbird", "manual", "wow-manager"]),
        externalId: z.string().min(1).max(255).optional(),
        configuration: z
          .object({ instructions: z.string().max(10000).optional() })
          .strict()
          .default({}),
        confirmation: z.literal("MANAGE"),
      })
      .strict()
      .parse(input);
    requireFresh(actor, d.confirmation, "MANAGE");
    if (d.provider === "pocket-id") {
      requirePermission(actor, "identity.manage");
      invariant(this.clients.pocket && d.externalId, "provider_not_configured");
      const group = await this.clients.pocket.group(d.externalId);
      const privileged =
        JSON.parse(this.config.ROLE_GROUP_MAPPINGS)[group.name] ?? [];
      invariant(
        !privileged.some((r: string) => r !== "member"),
        "privileged_portal_group_binding_forbidden",
      );
      invariant(!group.ldapId, "externally_managed_group");
    }
    if (d.provider === "netbird") {
      requirePermission(actor, "network.manage");
      invariant(
        this.clients.netbird && d.externalId,
        "provider_not_configured",
      );
      const group = await this.clients.netbird.group(d.externalId);
      invariant(
        group.name !== "All" && (!group.issued || group.issued === "api"),
        "incompatible_group_ownership",
      );
    }
    return this.db.transaction(async (tx) => {
      const [b] = await tx.query(
        "INSERT INTO bindings(entitlement_id,provider,external_id,configuration,managed) VALUES ($1,$2,$3,$4,true) RETURNING *",
        [
          d.entitlementId,
          d.provider,
          d.externalId ?? null,
          JSON.stringify(d.configuration),
        ],
      );
      await tx.query("UPDATE entitlements SET version=version+1 WHERE id=$1", [
        d.entitlementId,
      ]);
      await audit(tx, actor.id, "binding.create", b.id, d);
      return b;
    });
  }
  async roles(actor: Actor, user: string, input: unknown) {
    requirePermission(actor, "*");
    const d = z
      .object({
        roles: z
          .array(
            z.object({
              role: z.enum([
                "member",
                "support",
                "approver",
                "service-admin",
                "network-admin",
                "identity-admin",
                "owner",
              ]),
              scope: z.union([z.literal("*"), z.uuid()]),
            }),
          )
          .min(1)
          .max(30),
        confirmation: z.literal("CHANGE ROLES"),
      })
      .strict()
      .parse(input);
    requireFresh(actor, d.confirmation, "CHANGE ROLES");
    invariant(user !== actor.id, "cannot_change_own_roles");
    await this.db.transaction(async (tx) => {
      await tx.userLock(user);
      await tx.query(
        "DELETE FROM roles WHERE user_id=$1 AND source='operator'",
        [user],
      );
      for (const r of d.roles)
        await tx.query(
          "INSERT INTO roles(user_id,role,scope) VALUES ($1,$2,$3)",
          [user, r.role, r.scope],
        );
      await invalidate(tx, user);
      await audit(tx, actor.id, "roles.change", user, d, user);
    });
    return { ok: true };
  }
  async secret(actor: Actor, name: string, value: string) {
    requirePermission(actor, "*");
    invariant(value.length > 0 && value.length < 10000, "invalid_secret");
    const [s] = await this.db.query(
      "INSERT INTO secret_references(name,ciphertext,updated_by) VALUES ($1,$2,$3) ON CONFLICT(name) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING id,name,updated_at",
      [name, encrypt(value, this.config.ENCRYPTION_KEY), actor.id],
    );
    await audit(this.db, actor.id, "secret.rotate", s.id, { name });
    return s;
  }
  async getSecret(id: string) {
    const [s] = await this.db.query(
      "SELECT ciphertext FROM secret_references WHERE id=$1",
      [id],
    );
    invariant(s, "secret_reference_missing");
    return decrypt(s.ciphertext, this.config.ENCRYPTION_KEY);
  }
}
