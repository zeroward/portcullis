import Fastify, { LogController } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import { stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Config } from "./config.js";
import { Database } from "./db/index.js";
import { Auth } from "./auth.js";
import { AppError, invariant } from "./errors.js";
import { equal, signedBody, redact } from "./security.js";
import { PocketIdClient } from "./providers/pocket-id.js";
import { NetBirdClient, narrowPolicy } from "./providers/netbird.js";
import { WaygateClient } from "./providers/waygate.js";
import { ProviderError } from "./providers/http.js";
import { serviceProviders } from "./providers/contracts.js";
import { Catalog, rdpFile } from "./domain/catalog.js";
import { Access } from "./domain/access.js";
import { Tickets } from "./domain/tickets.js";
import { Devices } from "./domain/devices.js";
import { Guides } from "./domain/guides.js";
import { Files } from "./files.js";
import { Notices } from "./domain/notices.js";
import { Admin } from "./domain/admin.js";
import { Monitoring } from "./monitoring.js";
import {
  requirePermission,
  requireFresh,
  can,
} from "./domain/authorization.js";
import { audit, enqueue } from "./domain/audit.js";
import type { IntegrationClients } from "./domain/jobs.js";
import { registerFormOptions } from "./form-options.js";

export function integrationClients(config: Config): IntegrationClients {
  const caps = JSON.parse(config.CAPABILITY_OVERRIDES);
  return {
    pocket: config.POCKET_ID_URL
      ? new PocketIdClient(
          config.POCKET_ID_URL,
          config.POCKET_ID_API_KEY ?? "",
          caps,
        )
      : undefined,
    netbird: config.NETBIRD_URL
      ? new NetBirdClient(config.NETBIRD_URL, config.NETBIRD_TOKEN ?? "", caps)
      : undefined,
    waygate: config.WAYGATE_URL
      ? new WaygateClient(
          config.WAYGATE_URL,
          config.WAYGATE_TOKEN ?? config.MANAGEMENT_API_TOKEN ?? "",
          caps,
        )
      : undefined,
    protectedPocketGroups: Object.entries(
      JSON.parse(config.ROLE_GROUP_MAPPINGS),
    )
      .filter(([, roles]) => (roles as string[]).some((r) => r !== "member"))
      .map(([name]) => name),
  };
}
export async function createApp(
  config: Config,
  options: {
    db?: Database;
    clients?: IntegrationClients;
    static?: boolean;
    logger?: boolean;
  } = {},
) {
  const db = options.db ?? new Database(config.DATABASE_URL);
  const clients = options.clients ?? integrationClients(config);
  const app = Fastify({
    logger:
      (options.logger ?? config.NODE_ENV !== "test")
        ? {
            redact: [
              "req.headers.cookie",
              "req.headers.authorization",
              "req.headers.x-api-key",
              "req.headers.x-csrf-token",
            ],
            level: "info",
          }
        : false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1024 * 1024,
    trustProxy: config.TRUSTED_PROXIES
      ? config.TRUSTED_PROXIES.split(",")
      : false,
    requestTimeout: 15000,
  });
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "https:", "data:"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
  });
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: "1 minute",
    allowList: (r) => !r.url.startsWith("/api/") && !r.url.startsWith("/auth/"),
  });
  await app.register(multipart, {
    limits: { fileSize: 5242880, files: 1, fields: 2 },
  });
  const auth = new Auth(db, config, clients.pocket);
  auth.register(app);
  const catalog = new Catalog(db, config.NODE_ENV === "production");
  const access = new Access(db);
  const tickets = new Tickets(db, catalog);
  const devices = new Devices(db, config, clients.netbird);
  const guides = new Guides(db);
  const files = new Files(db, config, tickets, guides);
  const notices = new Notices(db);
  const admin = new Admin(db, config, clients);
  const monitoring = new Monitoring(db, config, (id) => admin.getSecret(id));
  const id = (r: any) => z.uuid().parse(r.params.id);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError)
      return reply
        .code(error.status)
        .send({ error: error.code, message: error.message });
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: "validation_failed",
        fields: error.issues.map((i) => i.path.join(".")),
      });
    if (error instanceof ProviderError)
      return reply.code(502).send({
        error: error.code,
        provider: error.provider,
        retryable: error.retryable,
        ...(error.details
          ? {
              details: error.details,
              message: `${error.message}: ${error.details.method} ${error.details.path} (${error.details.reason}${error.details.fields?.length ? `: ${error.details.fields.join(", ")}` : ""})`,
            }
          : {}),
      });
    const pgCode = (error as any).code;
    if (["23505", "23503", "23514"].includes(pgCode))
      return reply.code(409).send({ error: "constraint_conflict" });
    if ((error as any).statusCode)
      return reply
        .code((error as any).statusCode)
        .send({ error: "request_rejected" });
    app.log.error({ name: (error as Error).name }, "Request failed");
    return reply.code(500).send({ error: "internal_error" });
  });
  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/api/") || request.url.startsWith("/files/")) {
      if (request.url === "/api/health/incoming") return;
      request.actor = await auth.actor(request);
      reply.header("Cache-Control", "no-store");
      if (!["GET", "HEAD"].includes(request.method)) auth.csrf(request);
    }
  });
  app.get("/healthz", () => ({ status: "ok" }));
  registerFormOptions(app, db, clients, config);
  app.get("/readyz", async () => {
    await db.query("SELECT 1 FROM schema_migrations LIMIT 1");
    return { status: "ready" };
  });
  app.get("/api/me", async (r) => {
    const [diagnostics] = await db.query(
      `SELECT
        (SELECT count(*)::int FROM grants WHERE user_id=$1 AND desired AND fulfillment='active' AND (expires_at IS NULL OR expires_at>now())) AS "activeGrants",
        (SELECT count(*)::int FROM devices WHERE user_id=$1 AND lost_at IS NULL) AS "devices",
        EXISTS(SELECT 1 FROM identity_links WHERE user_id=$1 AND provider='netbird') AS "netbirdLinked",
        (SELECT count(*)::int FROM notifications WHERE user_id=$1 AND read_at IS NULL) AS "unreadUpdates",
        (SELECT count(*)::int FROM incidents WHERE state<>'resolved') AS "openIncidents"`,
      [r.actor.id],
    );
    return {
      ...r.actor,
      sessionId: undefined,
      authenticatedAt: undefined,
      development: config.NODE_ENV !== "production",
      diagnostics,
    };
  });
  app.patch("/api/me", async (r) => {
    const d = z.object({ timezone: z.string() }).strict().parse(r.body);
    new Intl.DateTimeFormat("en", { timeZone: d.timezone });
    await db.query("UPDATE users SET timezone=$1 WHERE id=$2", [
      d.timezone,
      r.actor.id,
    ]);
    return { ok: true };
  });
  app.get("/api/services", (r) => catalog.cards(r.actor));
  app.get("/api/services/:id", (r) => catalog.detail(r.actor, id(r)));
  app.post("/api/services", (r) => catalog.save(r.actor, r.body));
  app.put("/api/services/:id", (r) => catalog.save(r.actor, r.body, id(r)));
  app.delete("/api/services/:id", async (r) => {
    requireFresh(r.actor, (r.body as any)?.confirmation, "DELETE");
    await catalog.remove(r.actor, id(r));
    return { ok: true };
  });
  app.put("/api/services/:id/favorite", async (r) => {
    await catalog.detail(r.actor, id(r));
    const d = z.object({ favorite: z.boolean() }).parse(r.body);
    if (d.favorite)
      await db.query(
        "INSERT INTO favorites VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [r.actor.id, id(r)],
      );
    else
      await db.query(
        "DELETE FROM favorites WHERE user_id=$1 AND service_id=$2",
        [r.actor.id, id(r)],
      );
    return { ok: true };
  });
  app.get("/api/services/:id/rdp", async (r, reply) => {
    const card: any = await catalog.detail(r.actor, id(r));
    invariant(card.metadata, "access_required", 403);
    const endpoint = card.metadata.endpoints.find(
      (e: any) => e.protocol === "rdp",
    );
    invariant(endpoint, "rdp_unavailable", 404);
    return reply
      .type("application/x-rdp")
      .header("Content-Disposition", 'attachment; filename="connection.rdp"')
      .send(rdpFile(endpoint.host, endpoint.ports[0]));
  });
  app.get("/api/services/:id/waygate", async (r) => {
    const card: any = await catalog.detail(r.actor, id(r));
    invariant(card.metadata, "access_required", 403);
    invariant(
      card.metadata.provider === "wow-manager",
      "provider_mismatch",
      400,
    );
    invariant(clients.waygate, "provider_not_configured", 503);
    const q = z
      .object({
        resource: z
          .enum(["dashboard", "status", "players", "leaderboards", "modules"])
          .default("dashboard"),
      })
      .parse(r.query);
    if (q.resource === "status") return clients.waygate.status();
    if (q.resource === "players") return clients.waygate.players();
    if (q.resource === "leaderboards") return clients.waygate.leaderboards();
    if (q.resource === "modules") return clients.waygate.modules();
    return clients.waygate.dashboard();
  });
  app.get("/api/entitlements", async (r) =>
    (await access.list())
      .filter((e) => e.policy.requestable || can(r.actor, "access.manage"))
      .map((e) => ({
        id: e.id,
        key: e.key,
        name: e.name,
        policy: e.policy,
        version: e.version,
      })),
  );
  app.post("/api/entitlements", (r) => access.save(r.actor, r.body));
  app.get("/api/admin/access-configuration", (r) =>
    access.configuration(r.actor),
  );
  app.put("/api/entitlements/:id", (r) => access.save(r.actor, r.body, id(r)));
  app.get("/api/bundles", async (r) => {
    const b = await db.query("SELECT * FROM bundles WHERE requestable OR $1", [
      can(r.actor, "access.manage"),
    ]);
    return b;
  });
  app.post("/api/bundles", async (r) => {
    requirePermission(r.actor, "access.manage");
    const d = z
      .object({
        name: z.string().min(2).max(100),
        requestable: z.boolean(),
        entitlementIds: z.array(z.uuid()).min(1),
      })
      .strict()
      .parse(r.body);
    return db.transaction(async (tx) => {
      const [b] = await tx.query(
        "INSERT INTO bundles(name,requestable) VALUES ($1,$2) RETURNING *",
        [d.name, d.requestable],
      );
      for (const e of new Set(d.entitlementIds))
        await tx.query("INSERT INTO bundle_items VALUES ($1,$2)", [b.id, e]);
      await audit(tx, r.actor.id, "bundle.create", b.id, d);
      return b;
    });
  });
  app.put("/api/bundles/:id", async (r) => {
    requirePermission(r.actor, "access.manage");
    const d = z
      .object({
        name: z.string().min(2).max(100),
        requestable: z.boolean(),
        entitlementIds: z.array(z.uuid()).min(1),
        version: z.number().int(),
      })
      .strict()
      .parse(r.body);
    return db.transaction(async (tx) => {
      const [b] = await tx.query(
        "UPDATE bundles SET name=$1,requestable=$2,version=version+1 WHERE id=$3 AND version=$4 RETURNING *",
        [d.name, d.requestable, id(r), d.version],
      );
      invariant(b, "version_conflict", 409);
      await tx.query("DELETE FROM bundle_items WHERE bundle_id=$1", [b.id]);
      for (const e of new Set(d.entitlementIds))
        await tx.query("INSERT INTO bundle_items VALUES ($1,$2)", [b.id, e]);
      await audit(tx, r.actor.id, "bundle.update", b.id, d);
      return b;
    });
  });
  app.get("/api/access", (r) => access.mine(r.actor));
  app.post("/api/requests", (r) => access.request(r.actor, r.body));
  app.post("/api/requests/:id/decide", (r) =>
    access.decide(r.actor, id(r), r.body),
  );
  app.get("/api/approvals", async (r) => {
    const result = [];
    for (const q of await db.query(
      "SELECT * FROM access_requests WHERE status IN ('pending','needs-information')",
    )) {
      try {
        for (const e of q.snapshot.items)
          await access.approvalPermission(r.actor, db, e.id);
        result.push(q);
      } catch {
        /* Filter unauthorized requests. */
      }
    }
    return result;
  });
  app.post("/api/requests/:id/cancel", async (r) => {
    const [q] = await db.query(
      "UPDATE access_requests SET status='canceled',version=version+1 WHERE id=$1 AND user_id=$2 AND status IN('pending','needs-information') RETURNING id",
      [id(r), r.actor.id],
    );
    invariant(q, "not_found", 404);
    await audit(db, r.actor.id, "request.cancel", id(r));
    return { ok: true };
  });
  app.post("/api/grants", (r) => {
    requireFresh(r.actor, (r.body as any)?.confirmation, "GRANT");
    const { confirmation: _c, ...input } = r.body as any;
    return access.grant(r.actor, input);
  });
  app.post("/api/grants/:id/revoke", (r) => {
    requireFresh(r.actor, (r.body as any)?.confirmation, "REVOKE");
    return access.revoke(r.actor, id(r));
  });
  app.post("/api/grants/:id/renew", (r) =>
    access.renew(
      r.actor,
      id(r),
      z
        .object({ durationHours: z.number().int().min(1).max(8760) })
        .parse(r.body).durationHours,
    ),
  );
  app.post("/api/steps/:id/attest", async (r) => {
    const d = z
      .object({ reason: z.string().min(5), confirmation: z.literal("ATTEST") })
      .strict()
      .parse(r.body);
    requireFresh(r.actor, d.confirmation, "ATTEST");
    await access.attest(r.actor, id(r), d.reason);
    return { ok: true };
  });
  app.get("/api/tickets", (r) => tickets.list(r.actor));
  app.post("/api/tickets", (r) => tickets.create(r.actor, r.body));
  app.get("/api/tickets/:id", (r) => tickets.detail(r.actor, id(r)));
  app.post("/api/tickets/:id/comments", (r) =>
    tickets.comment(r.actor, id(r), r.body),
  );
  app.patch("/api/tickets/:id", (r) => tickets.update(r.actor, id(r), r.body));
  app.post("/api/files/:id", async (r) => {
    const kind = (r.query as any).kind;
    invariant(["ticket", "guide"].includes(kind), "invalid_file_target");
    const file = await r.file();
    invariant(file, "file_required");
    return files.upload(
      r.actor,
      kind === "ticket" ? { ticket_id: id(r) } : { guide_id: id(r) },
      file.filename,
      file.mimetype,
      await file.toBuffer(),
    );
  });
  app.get("/files/:id", async (r, reply) => {
    const a = await files.download(r.actor, id(r));
    return reply
      .type(a.mime)
      .header("Content-Disposition", `attachment; filename="${a.name}"`)
      .header("X-Content-Type-Options", "nosniff")
      .send(a.data);
  });
  app.get("/api/devices", (r) => devices.mine(r.actor));
  app.post("/api/devices/:id/lost", (r) =>
    devices.lost(r.actor, id(r), tickets),
  );
  app.delete("/api/devices/:id", async (r) => {
    requireFresh(r.actor, (r.body as any)?.confirmation, "REMOVE DEVICE");
    await devices.remove(r.actor, id(r));
    return { ok: true };
  });
  app.get("/api/guides", (r) => guides.list(r.actor));
  app.post("/api/guides", (r) => guides.save(r.actor, r.body));
  app.put("/api/guides/:id", (r) => guides.save(r.actor, r.body, id(r)));
  app.get("/api/guides/:id/history", async (r) => {
    await guides.get(r.actor, id(r));
    return db.query(
      "SELECT * FROM guide_versions WHERE guide_id=$1 ORDER BY version DESC",
      [id(r)],
    );
  });
  app.get("/api/guides/:id/files", async (r) => {
    await guides.get(r.actor, id(r));
    return db.query(
      "SELECT id,name,mime,size FROM attachments WHERE guide_id=$1",
      [id(r)],
    );
  });
  app.post("/api/guides/:id/accept", async (r) => {
    await guides.accept(
      r.actor,
      id(r),
      z.object({ version: z.number().int() }).parse(r.body).version,
    );
    return { ok: true };
  });
  app.get("/api/onboarding", (r) => guides.onboarding(r.actor));
  app.post("/api/onboarding", async (r) => {
    await guides.complete(
      r.actor,
      z.object({ step: z.string() }).parse(r.body).step,
    );
    return { ok: true };
  });
  app.post("/api/invitations", (r) =>
    guides.invite(
      r.actor,
      z.object({ hours: z.number().int() }).parse(r.body).hours,
    ),
  );
  app.post("/api/invitations/redeem", (r) =>
    guides.redeem(
      r.actor,
      z.object({ invitation: z.string().min(20).max(100) }).parse(r.body)
        .invitation,
    ),
  );
  app.delete("/api/invitations/:id", async (r) => {
    requirePermission(r.actor, "identity.manage");
    await db.query("UPDATE invitations SET revoked_at=now() WHERE id=$1", [
      id(r),
    ]);
    await audit(db, r.actor.id, "invitation.revoke", id(r));
    return { ok: true };
  });
  app.get("/api/notifications", (r) =>
    db.query(
      "SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200",
      [r.actor.id],
    ),
  );
  app.post("/api/notifications/:id/read", async (r) => {
    await db.query(
      "UPDATE notifications SET read_at=now() WHERE id=$1 AND user_id=$2",
      [id(r), r.actor.id],
    );
    return { ok: true };
  });
  app.get("/api/notification-preferences", (r) =>
    db.query(
      "SELECT channel,enabled FROM notification_preferences WHERE user_id=$1",
      [r.actor.id],
    ),
  );
  app.put("/api/notification-preferences", async (r) => {
    const d = z
      .object({
        channel: z.enum(["smtp", "discord", "webhook"]),
        enabled: z.boolean(),
      })
      .parse(r.body);
    await db.query(
      "INSERT INTO notification_preferences(user_id,channel,enabled) VALUES ($1,$2,$3) ON CONFLICT(user_id,channel) DO UPDATE SET enabled=EXCLUDED.enabled",
      [r.actor.id, d.channel, d.enabled],
    );
    return { ok: true };
  });
  app.get("/api/notices", (r) => notices.list(r.actor));
  app.post("/api/announcements", (r) => notices.announce(r.actor, r.body));
  app.post("/api/maintenance", (r) => notices.maintenance(r.actor, r.body));
  app.post("/api/incidents", (r) => notices.incident(r.actor, r.body));
  app.post("/api/incidents/:id", (r) =>
    notices.incident(r.actor, r.body, id(r)),
  );
  app.get("/api/incidents/:id/timeline", async (r) => {
    const [n] = await db.query("SELECT * FROM incidents WHERE id=$1", [id(r)]);
    invariant(
      n && (await notices.visible(r.actor, n.service_id)),
      "not_found",
      404,
    );
    return db.query(
      "SELECT * FROM incident_updates WHERE incident_id=$1 ORDER BY created_at",
      [id(r)],
    );
  });
  app.post("/api/maintenance/:id/start", (r) =>
    notices.changeMaintenance(r.actor, id(r), "start"),
  );
  app.post("/api/maintenance/:id/end", (r) =>
    notices.changeMaintenance(r.actor, id(r), "end"),
  );
  app.get("/api/providers", async () =>
    serviceProviders(
      config.NODE_ENV === "production",
      config.ENABLE_MOCK_PROVIDERS === "true",
      clients.waygate,
    ).map((p) => ({
      id: p.id,
      contractVersion: p.contractVersion,
      capabilities: p.capabilities,
      availability:
        p.id === "wow-manager"
          ? clients.waygate?.isConfigured()
            ? "configured (read-only telemetry; manual account fulfillment)"
            : "Awaiting API specification"
          : "configured",
      actions: p.actions.map((a) => ({
        id: a.id,
        permission: a.permission,
        confirmation: a.confirmation,
      })),
    })),
  );
  app.post("/api/health/checks", (r) => monitoring.save(r.actor, r.body));
  app.get("/api/health/checks", async (r) => {
    const rows = await db.query("SELECT * FROM health_checks");
    return rows.filter((c) => can(r.actor, "monitor.manage", c.service_id));
  });
  app.post("/api/health/checks/:id/manual", async (r) => {
    const [c] = await db.query(
      "SELECT * FROM health_checks WHERE id=$1 AND kind='manual'",
      [id(r)],
    );
    invariant(c, "not_found", 404);
    requirePermission(r.actor, "monitor.manage", c.service_id);
    const d = z
      .object({
        state: z.enum(["healthy", "degraded", "down", "unknown"]),
        reason: z.string().min(3),
      })
      .parse(r.body);
    await monitoring.observe(
      c.id,
      d.state,
      "manual",
      `Administrator ${r.actor.id}`,
      3600,
      { reason: d.reason },
    );
    await audit(db, r.actor.id, "health.manual", c.id, d);
    return { ok: true };
  });
  app.post("/api/health/incoming", async (r) => {
    invariant(config.HEALTH_WEBHOOK_KEY, "webhook_disabled", 404);
    const d = z
      .object({
        checkId: z.uuid(),
        state: z.enum(["healthy", "degraded", "down", "unknown"]),
        timestamp: z.number().int(),
        nonce: z.string().min(16).max(100),
        vantage: z.string().max(120),
      })
      .strict()
      .parse(r.body);
    invariant(
      Math.abs(Date.now() - d.timestamp) < 300000,
      "webhook_expired",
      401,
    );
    invariant(
      typeof r.headers["x-portcullis-signature"] === "string" &&
        equal(
          signedBody(JSON.stringify(r.body), config.HEALTH_WEBHOOK_KEY),
          r.headers["x-portcullis-signature"],
        ),
      "invalid_signature",
      401,
    );
    await db.transaction(async (tx) => {
      const [n] = await tx.query(
        "INSERT INTO webhook_nonces(nonce) VALUES ($1) ON CONFLICT DO NOTHING RETURNING nonce",
        [d.nonce],
      );
      invariant(n, "webhook_replay", 409);
      const [c] = await tx.query(
        "SELECT id FROM health_checks WHERE id=$1 AND kind='incoming' AND enabled",
        [d.checkId],
      );
      invariant(c, "not_found", 404);
      await tx.query(
        "INSERT INTO health_observations(check_id,state,source,vantage,expires_at) VALUES ($1,$2,'incoming',$3,now()+interval '3 minutes')",
        [d.checkId, d.state, d.vantage],
      );
    });
    return { ok: true };
  });
  app.get("/api/admin", (r) => admin.summary(r.actor));
  app.get("/api/admin/users", async (r) => {
    requirePermission(r.actor, "identity.manage");
    return db.query("SELECT * FROM users ORDER BY name");
  });
  app.get("/api/admin/links", async (r) => {
    invariant(
      can(r.actor, "identity.manage") || can(r.actor, "network.manage"),
      "forbidden",
      403,
    );
    return db.query("SELECT * FROM identity_links");
  });
  app.post("/api/admin/links", (r) => admin.link(r.actor, r.body));
  app.post("/api/admin/bindings", (r) => admin.binding(r.actor, r.body));
  app.get("/api/admin/bindings", async (r) => {
    requirePermission(r.actor, "access.manage");
    return db.query("SELECT * FROM bindings ORDER BY provider");
  });
  app.put("/api/admin/users/:id/roles", (r) =>
    admin.roles(r.actor, id(r), r.body),
  );
  app.post("/api/admin/users/:id/suspend", async (r) => {
    const d = z
      .object({ suspended: z.boolean(), confirmation: z.literal("SUSPEND") })
      .parse(r.body);
    requireFresh(r.actor, d.confirmation, "SUSPEND");
    await access.suspend(r.actor, id(r), d.suspended);
    return { ok: true };
  });
  app.post("/api/admin/users/:id/offboard", async (r) => {
    requirePermission(r.actor, "*");
    requireFresh(r.actor, (r.body as any)?.confirmation, "OFFBOARD");
    await access.suspend(r.actor, id(r), true);
    for (const g of await db.query(
      "SELECT id FROM grants WHERE user_id=$1 AND desired",
      [id(r)],
    ))
      await access.revoke(r.actor, g.id);
    await audit(db, r.actor.id, "user.offboard", id(r));
    return { ok: true };
  });
  app.get("/api/admin/grants", async (r) => {
    requirePermission(r.actor, "access.manage");
    return db.query(
      "SELECT g.*,u.name,e.name AS entitlement_name FROM grants g JOIN users u ON u.id=g.user_id JOIN entitlements e ON e.id=g.entitlement_id ORDER BY g.created_at DESC",
    );
  });
  app.get("/api/admin/steps", async (r) => {
    requirePermission(r.actor, "access.manage");
    return db.query("SELECT * FROM fulfillment_steps");
  });
  app.post("/api/admin/steps/:id/removal-attest", async (r) => {
    requirePermission(r.actor, "access.manage");
    const d = z
      .object({
        reason: z.string().min(5),
        confirmation: z.literal("ATTEST REMOVAL"),
      })
      .parse(r.body);
    requireFresh(r.actor, d.confirmation, "ATTEST REMOVAL");
    const [s] = await db.query(
      "SELECT s.*,g.user_id,g.desired FROM fulfillment_steps s JOIN grants g ON g.id=s.grant_id JOIN bindings b ON b.id=s.binding_id WHERE s.id=$1 AND b.provider IN ('manual','wow-manager')",
      [id(r)],
    );
    invariant(s && !s.desired, "removal_not_required");
    await db.withLock(`user:${s.user_id}`, async (locked) => {
      invariant(
        !(
          await locked.query(
            "SELECT 1 FROM grants g JOIN fulfillment_steps fs ON fs.grant_id=g.id WHERE g.user_id=$1 AND fs.binding_id=$2 AND g.desired AND (g.expires_at IS NULL OR g.expires_at>now())",
            [s.user_id, s.binding_id],
          )
        ).length,
        "overlapping_manual_access_still_desired",
        409,
      );
      await locked.query(
        "UPDATE fulfillment_steps SET status='revoked',attested_by=NULL,observed=$1 WHERE binding_id=$2 AND grant_id IN (SELECT id FROM grants WHERE user_id=$3)",
        [
          JSON.stringify({ manualRemoval: d.reason, actor: r.actor.id }),
          s.binding_id,
          s.user_id,
        ],
      );
      await audit(
        locked,
        r.actor.id,
        "fulfillment.removal-attest",
        id(r),
        { reason: d.reason },
        s.user_id,
      );
      await enqueue(
        locked,
        "reconcile-user",
        s.user_id,
        {},
        `removal:${id(r)}:${Date.now()}`,
      );
    });
    return { ok: true };
  });
  app.post("/api/admin/jobs/:id/retry", async (r) => {
    requirePermission(r.actor, "*");
    await db.query(
      "UPDATE jobs SET status='queued',attempts=0,available_at=now(),error=NULL WHERE id=$1 AND status='failed'",
      [id(r)],
    );
    await audit(db, r.actor.id, "job.retry", id(r));
    return { ok: true };
  });
  app.get("/api/admin/audit", async (r, reply) => {
    requirePermission(r.actor, "*");
    const q = z
      .object({
        action: z.string().max(100).optional(),
        subject: z.uuid().optional(),
        export: z.enum(["true"]).optional(),
      })
      .parse(r.query);
    const rows = await db.query(
      "SELECT * FROM audit_events WHERE ($1::text IS NULL OR action=$1) AND ($2::uuid IS NULL OR subject_id=$2) ORDER BY created_at DESC LIMIT 2000",
      [q.action ?? null, q.subject ?? null],
    );
    if (q.export)
      return reply
        .type("application/json")
        .header("Content-Disposition", 'attachment; filename="audit.json"')
        .send(rows);
    return rows;
  });
  app.get("/api/admin/preview/:id", async (r) => {
    requirePermission(r.actor, "*");
    const [u] = await db.query("SELECT * FROM users WHERE id=$1", [id(r)]);
    invariant(u, "not_found", 404);
    const roles = await db.query(
      "SELECT role,scope FROM roles WHERE user_id=$1",
      [u.id],
    );
    await audit(db, r.actor.id, "user.preview", u.id, {}, u.id);
    return {
      readOnly: true,
      banner: `Read-only preview for ${u.name}; actor remains ${r.actor.name}`,
      cards: await catalog.cards({ ...r.actor, id: u.id, roles }),
    };
  });
  app.post("/api/admin/secrets", (r) => {
    requireFresh(r.actor, (r.body as any)?.confirmation, "ROTATE SECRET");
    const d = z
      .object({
        name: z.string().regex(/^[a-zA-Z0-9.-]{2,100}$/),
        value: z.string().min(1),
        confirmation: z.literal("ROTATE SECRET"),
      })
      .parse(r.body);
    return admin.secret(r.actor, d.name, d.value);
  });
  app.get("/api/admin/waygate", async (r) => {
    invariant(
      r.actor.roles.some((role) => can(r.actor, "catalog.manage", role.scope)),
      "forbidden",
      403,
    );
    invariant(clients.waygate, "provider_not_configured", 503);
    const q = z
      .object({
        resource: z
          .enum(["dashboard", "status", "players", "leaderboards", "modules"])
          .optional(),
      })
      .parse(r.query);
    if (q.resource === "status") return clients.waygate.status();
    if (q.resource === "players") return clients.waygate.players();
    if (q.resource === "leaderboards") return clients.waygate.leaderboards();
    if (q.resource === "modules") return clients.waygate.modules();
    return redact({
      diagnostics: await clients.waygate.diagnostics(),
      dashboard: await clients.waygate.dashboard(),
    });
  });
  app.get("/api/admin/pocket-id", async (r) => {
    requirePermission(r.actor, "identity.manage");
    invariant(clients.pocket, "provider_not_configured", 503);
    return redact({
      diagnostics: await clients.pocket.diagnostics(),
      users: await clients.pocket.users(),
      groups: await clients.pocket.groups(),
    });
  });
  app.post("/api/admin/users/:id/refresh-identity", async (r) => {
    requirePermission(r.actor, "identity.manage");
    await auth.refreshIdentity(id(r));
    return { observed: true };
  });
  app.post("/api/admin/pocket-id/users", async (r) => {
    requirePermission(r.actor, "identity.manage");
    requireFresh(r.actor, (r.body as any)?.confirmation, "CREATE USER");
    invariant(clients.pocket, "provider_not_configured", 503);
    const { confirmation: _c, ...input } = r.body as any;
    const u = await clients.pocket.createUser(input);
    await audit(db, r.actor.id, "pocket.user.create", u.id);
    return u;
  });
  app.post("/api/admin/pocket-id/groups", async (r) => {
    requirePermission(r.actor, "identity.manage");
    requireFresh(r.actor, (r.body as any)?.confirmation, "CREATE GROUP");
    invariant(clients.pocket, "provider_not_configured", 503);
    const d = z
      .object({
        name: z.string(),
        friendlyName: z.string(),
        confirmation: z.literal("CREATE GROUP"),
      })
      .parse(r.body);
    const g = await clients.pocket.createGroup(d.name, d.friendlyName);
    await audit(db, r.actor.id, "pocket.group.create", g.id);
    return g;
  });
  app.post("/api/admin/pocket-id/users/:externalId/enrollment", async (r) => {
    requirePermission(r.actor, "identity.manage");
    requireFresh(r.actor, (r.body as any)?.confirmation, "ENROLLMENT");
    invariant(clients.pocket, "provider_not_configured", 503);
    const external = z
      .string()
      .max(255)
      .parse((r.params as any).externalId);
    const result = await clients.pocket.enrollment(external);
    await audit(db, r.actor.id, "pocket.enrollment", external);
    return result;
  });
  app.get("/api/admin/network", async (r) => {
    requirePermission(r.actor, "network.manage");
    invariant(clients.netbird, "provider_not_configured", 503);
    return {
      diagnostics: await clients.netbird.diagnostics(),
      users: await clients.netbird.users(),
      groups: await clients.netbird.groups(),
      peers: await clients.netbird.peers(),
      policies: await clients.netbird.policies(),
      warnings: await clients.netbird.broadPolicyWarnings(),
      devices: await db.query(
        "SELECT d.*,u.name AS owner FROM devices d JOIN users u ON u.id=d.user_id ORDER BY d.observed_at DESC",
      ),
      managedSetupKeys: await db.query("SELECT * FROM setup_keys"),
    };
  });
  app.get("/api/admin/network/advanced", async (r) => {
    requirePermission(r.actor, "network.manage");
    invariant(clients.netbird, "provider_not_configured", 503);
    const result: any = {};
    for (const [key, fn] of Object.entries({
      accounts: () => clients.netbird!.accounts(),
      dns: () => clients.netbird!.dns(),
      events: () => clients.netbird!.events(),
      setupKeys: () => clients.netbird!.setupKeys(),
      networks: () => clients.netbird!.networks(),
    })) {
      try {
        result[key] = { state: "observed", value: redact(await fn()) };
      } catch (e) {
        result[key] = {
          state: e instanceof ProviderError ? e.code : "unavailable",
        };
      }
    }
    return result;
  });
  app.post("/api/admin/network/policy-preview", async (r) => {
    requirePermission(r.actor, "network.manage");
    invariant(clients.netbird, "provider_not_configured", 503);
    const desired = narrowPolicy.parse(r.body);
    return {
      desired,
      affectedGroups: [desired.sourceGroup, desired.destinationGroup],
      existingGroups: await clients.netbird.groups(),
      warnings: await clients.netbird.broadPolicyWarnings(),
      managed: true,
      trafficVerification: false,
    };
  });
  app.post("/api/admin/network/policies", async (r) => {
    requirePermission(r.actor, "network.manage");
    requireFresh(r.actor, (r.body as any)?.confirmation, "CREATE POLICY");
    invariant(clients.netbird, "provider_not_configured", 503);
    const { confirmation: _c, ...input } = r.body as any;
    const p = await clients.netbird.createPolicy(input);
    await db.query(
      "INSERT INTO settings(key,value,updated_by) VALUES ($1,$2,$3)",
      [`netbird.policy.${p.id}`, JSON.stringify({ managed: true }), r.actor.id],
    );
    await audit(db, r.actor.id, "network.policy.create", p.id, input);
    return p;
  });
  app.post("/api/admin/network/groups", async (r) => {
    requirePermission(r.actor, "network.manage");
    requireFresh(r.actor, (r.body as any)?.confirmation, "CREATE GROUP");
    invariant(clients.netbird, "provider_not_configured", 503);
    const g = await clients.netbird.createGroup(
      z.object({ name: z.string() }).parse(r.body).name,
    );
    await audit(db, r.actor.id, "network.group.create", g.id);
    return g;
  });
  app.post("/api/admin/network/resource-preview", async (r) => {
    requirePermission(r.actor, "network.manage");
    invariant(clients.netbird, "provider_not_configured", 503);
    const d = z
      .object({
        networkId: z.string(),
        serviceId: z.uuid(),
        resource: z.object({
          name: z.string(),
          address: z.string(),
          groups: z.array(z.string()).min(1),
          enabled: z.boolean().default(true),
          description: z.string().default(""),
        }),
      })
      .strict()
      .parse(r.body);
    return {
      desired: d,
      existingResources: await clients.netbird.resources(d.networkId),
      routingPeers: await clients.netbird.routers(d.networkId),
      warnings: await clients.netbird.broadPolicyWarnings(),
      scope:
        "Single host or domain only; no subnets, wildcard domains or exit-node routes",
    };
  });
  app.post("/api/admin/network/resources", async (r) => {
    requirePermission(r.actor, "network.manage");
    invariant(clients.netbird, "provider_not_configured", 503);
    const d = z
      .object({
        networkId: z.string(),
        serviceId: z.uuid(),
        resource: z.unknown(),
        confirmation: z.literal("CREATE RESOURCE"),
      })
      .strict()
      .parse(r.body);
    requireFresh(r.actor, d.confirmation, "CREATE RESOURCE");
    const resource = await clients.netbird.createResource(
      d.networkId,
      d.resource,
    );
    await db.query(
      "INSERT INTO network_resources(service_id,external_id,metadata,managed) VALUES ($1,$2,$3,true)",
      [
        d.serviceId,
        resource.id,
        JSON.stringify({ networkId: d.networkId, ...resource }),
      ],
    );
    await audit(db, r.actor.id, "network.resource.create", resource.id, {
      networkId: d.networkId,
      serviceId: d.serviceId,
      controlPlaneVerified: true,
      trafficVerified: false,
    });
    return resource;
  });
  app.post("/api/admin/network/resources/map", async (r) => {
    requirePermission(r.actor, "network.manage");
    invariant(clients.netbird, "provider_not_configured", 503);
    const d = z
      .object({
        networkId: z.string(),
        serviceId: z.uuid(),
        externalId: z.string(),
        confirmation: z.literal("MAP INFRASTRUCTURE"),
      })
      .strict()
      .parse(r.body);
    requireFresh(r.actor, d.confirmation, "MAP INFRASTRUCTURE");
    const resource = (await clients.netbird.resources(d.networkId)).find(
      (x) => x.id === d.externalId,
    );
    invariant(resource, "resource_not_found");
    const [mapped] = await db.query(
      "INSERT INTO network_resources(service_id,external_id,metadata,managed) VALUES ($1,$2,$3,false) RETURNING *",
      [
        d.serviceId,
        d.externalId,
        JSON.stringify({ networkId: d.networkId, ...resource }),
      ],
    );
    await audit(db, r.actor.id, "network.resource.map", mapped.id, d);
    return mapped;
  });
  app.post("/api/admin/network/routers", async (r) => {
    requirePermission(r.actor, "network.manage");
    invariant(clients.netbird, "provider_not_configured", 503);
    const d = z
      .object({
        networkId: z.string(),
        router: z.object({
          peer: z.string(),
          metric: z.number().int(),
          masquerade: z.boolean(),
          enabled: z.boolean(),
        }),
        confirmation: z.literal("ASSOCIATE ROUTER"),
      })
      .strict()
      .parse(r.body);
    requireFresh(r.actor, d.confirmation, "ASSOCIATE ROUTER");
    invariant(
      (await clients.netbird.peers()).some((p) => p.id === d.router.peer),
      "existing_routing_peer_required",
    );
    const router = await clients.netbird.createRouter(d.networkId, d.router);
    await db.query(
      "INSERT INTO settings(key,value,updated_by) VALUES ($1,$2,$3)",
      [
        `netbird.router.${router.id}`,
        JSON.stringify({ managed: true, networkId: d.networkId, ...router }),
        r.actor.id,
      ],
    );
    await audit(db, r.actor.id, "network.router.associate", router.id, {
      ...d,
      controlPlaneVerified: true,
      trafficVerified: false,
    });
    return router;
  });
  app.post("/api/admin/network/setup-keys", async (r) => {
    requirePermission(r.actor, "network.manage");
    const d = z
      .object({
        userId: z.uuid(),
        name: z.string().min(2).max(100),
        groups: z.array(z.string()).max(5),
        confirmation: z.literal("CREATE ENROLLMENT KEY"),
      })
      .strict()
      .parse(r.body);
    requireFresh(r.actor, d.confirmation, "CREATE ENROLLMENT KEY");
    invariant(clients.netbird, "provider_not_configured", 503);
    for (const group of d.groups)
      invariant(
        (
          await db.query(
            "SELECT 1 FROM bindings WHERE provider='netbird' AND external_id=$1 AND managed",
            [group],
          )
        ).length,
        "unmanaged_group",
      );
    const key = await clients.netbird.createSetupKey(d.name, d.groups);
    await db.query(
      "INSERT INTO setup_keys(user_id,external_id,metadata) VALUES ($1,$2,$3)",
      [
        d.userId,
        key.id,
        JSON.stringify({
          name: d.name,
          type: "one-off",
          usageLimit: 1,
          expiresIn: 86400,
        }),
      ],
    );
    await audit(
      db,
      r.actor.id,
      "setup-key.create",
      key.id,
      { oneUse: true },
      d.userId,
    );
    return {
      id: key.id,
      key: key.key,
      reveal:
        "Only at creation. Key revocation does not remove enrolled peers.",
    };
  });
  app.post("/api/admin/network/setup-keys/:id/revoke", async (r) => {
    requirePermission(r.actor, "network.manage");
    requireFresh(r.actor, (r.body as any)?.confirmation, "REVOKE KEY");
    invariant(clients.netbird, "provider_not_configured", 503);
    const [k] = await db.query("SELECT * FROM setup_keys WHERE id=$1", [id(r)]);
    invariant(k, "not_found", 404);
    await clients.netbird.revokeSetupKey(k.external_id);
    await db.query("UPDATE setup_keys SET revoked_at=now() WHERE id=$1", [
      k.id,
    ]);
    await audit(db, r.actor.id, "setup-key.revoke", k.id, {
      peersRemoved: false,
    });
    return { revoked: true, peersRemoved: false };
  });
  if (options.static !== false) {
    const root = path.resolve("dist/web");
    if (await stat(root).catch(() => null)) {
      await app.register(staticFiles, { root, wildcard: false });
      app.setNotFoundHandler((r, reply) => {
        if (
          r.url.startsWith("/api/") ||
          r.url.startsWith("/files/") ||
          r.url.startsWith("/auth/")
        )
          return reply.code(404).send({ error: "not_found" });
        return reply.sendFile("index.html");
      });
    }
  }
  app.addHook("onClose", async () => {
    if (!options.db) await db.close();
  });
  return {
    app,
    db,
    auth,
    catalog,
    access,
    tickets,
    devices,
    guides,
    files,
    admin,
    monitoring,
    clients,
  };
}
