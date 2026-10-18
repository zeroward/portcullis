import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "./db/index.js";
import type { Config } from "./config.js";
import type { IntegrationClients } from "./domain/jobs.js";
import { can, requirePermission, type Actor } from "./domain/authorization.js";
import { Catalog } from "./domain/catalog.js";
import { Guides } from "./domain/guides.js";
import { Tickets } from "./domain/tickets.js";
import { invariant } from "./errors.js";

interface Option {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
  reason?: string;
}
const anywhere = (actor: Actor, permission: string) =>
  actor.roles.some((role) => can(actor, permission, role.scope));
const permitted = (actor: Actor, permission: string) =>
  invariant(anywhere(actor, permission), "forbidden", 403);

export function registerFormOptions(
  app: FastifyInstance,
  db: Database,
  clients: IntegrationClients,
  config: Config,
) {
  const catalog = new Catalog(db, config.NODE_ENV === "production");
  const guides = new Guides(db);
  const tickets = new Tickets(db, catalog);
  app.get("/api/form-options/:kind", async (request) => {
    const { kind } = request.params as { kind: string };
    const query = z
      .object({
        purpose: z.string().optional(),
        networkId: z.string().min(1).max(255).optional(),
        ticketId: z.uuid().optional(),
      })
      .strict()
      .parse(request.query);
    const actor = request.actor;
    const options = (rows: any[], label: (row: any) => string): Option[] =>
      rows.map((row) => ({ id: row.id, label: label(row) || row.id }));
    if (kind === "services") {
      const purpose = z
        .enum([
          "ticket",
          "catalog.manage",
          "guides.manage",
          "incident.manage",
          "monitor.manage",
          "network.manage",
          "role-scope",
        ])
        .parse(query.purpose ?? "ticket");
      if (purpose === "ticket")
        return options(await catalog.cards(actor), (s) => s.name);
      const permission = purpose === "role-scope" ? "*" : purpose;
      permitted(actor, permission);
      const rows = await db.query("SELECT id,name FROM services ORDER BY name");
      const result = options(
        rows.filter((s) => can(actor, permission, s.id)),
        (s) => s.name,
      );
      if (["guides.manage", "incident.manage"].includes(purpose))
        result.unshift({
          id: "",
          label: "All services",
          disabled: !can(actor, permission),
          reason: !can(actor, permission)
            ? "Requires community-wide permission"
            : undefined,
        });
      if (purpose === "role-scope")
        result.unshift({ id: "*", label: "All services" });
      return result;
    }
    if (kind === "users") {
      const purpose = z
        .enum(["identity.manage", "network.manage", "access.manage"])
        .parse(query.purpose);
      requirePermission(actor, purpose);
      const rows = await db.query(
        "SELECT id,name,email,suspended FROM users ORDER BY name",
      );
      return rows.map((u) => ({
        id: u.id,
        label: u.name,
        description: u.email ?? undefined,
        disabled: purpose !== "identity.manage" && u.suspended,
        reason: u.suspended ? "Portal account suspended" : undefined,
      }));
    }
    if (kind === "assignees") {
      invariant(query.ticketId, "ticket_required");
      const ticket = await tickets.visible(actor, query.ticketId);
      requirePermission(actor, "ticket.staff", ticket.service_id ?? "*");
      return options(
        await db.query(
          `SELECT DISTINCT u.id,u.name FROM users u JOIN roles r ON r.user_id=u.id
         WHERE NOT u.suspended AND r.role IN ('owner','support') AND (r.scope='*' OR r.scope=$1) ORDER BY u.name`,
          [ticket.service_id ?? "*"],
        ),
        (u) => u.name,
      );
    }
    if (kind === "entitlements" || kind === "guides") {
      requirePermission(actor, "access.manage");
      return kind === "entitlements"
        ? options(
            await db.query("SELECT id,name FROM entitlements ORDER BY name"),
            (e) => e.name,
          )
        : options(await guides.list(actor), (g) => g.title);
    }
    if (kind === "secrets") {
      permitted(actor, "monitor.manage");
      return options(
        await db.query("SELECT id,name FROM secret_references ORDER BY name"),
        (s) => s.name,
      );
    }
    if (kind === "jobs") {
      requirePermission(actor, "*");
      return options(
        await db.query(
          "SELECT id,kind,created_at FROM jobs WHERE status='failed' ORDER BY created_at DESC LIMIT 100",
        ),
        (j) =>
          `${j.kind} · ${new Date(j.created_at).toLocaleString("en-US", { timeZone: actor.timezone })}`,
      );
    }
    if (kind === "providers") {
      const purpose = z
        .enum(["link", "binding", "service"])
        .parse(query.purpose);
      if (purpose === "service") {
        requirePermission(actor, "catalog.manage");
        return [
          { id: "manual", label: "Manual fulfillment" },
          {
            id: "wow-manager",
            label: "WoW manager",
            disabled: true,
            reason:
              "Awaiting API specification; existing bindings support manual attestation",
          },
          ...(config.NODE_ENV !== "production" &&
          config.ENABLE_MOCK_PROVIDERS === "true"
            ? [{ id: "mock", label: "Development mock" }]
            : []),
        ];
      }
      if (purpose === "binding") requirePermission(actor, "access.manage");
      else
        invariant(
          can(actor, "identity.manage") || can(actor, "network.manage"),
          "forbidden",
          403,
        );
      const result: Option[] =
        purpose === "binding"
          ? [
              { id: "manual", label: "Manual fulfillment" },
              {
                id: "wow-manager",
                label: "WoW manager",
                disabled: true,
                reason: "Awaiting API specification; use manual fulfillment",
              },
            ]
          : [];
      if (can(actor, "identity.manage"))
        result.push({
          id: "pocket-id",
          label: "Pocket ID",
          disabled: !clients.pocket,
          reason: !clients.pocket ? "Pocket ID is not configured" : undefined,
        });
      if (can(actor, "network.manage"))
        result.push({
          id: "netbird",
          label: "NetBird",
          disabled: !clients.netbird,
          reason: !clients.netbird ? "NetBird is not configured" : undefined,
        });
      return result;
    }
    if (kind === "pocket-users" || kind === "pocket-groups") {
      requirePermission(actor, "identity.manage");
      invariant(clients.pocket, "provider_not_configured", 503);
      if (kind === "pocket-users")
        return (await clients.pocket.users()).map((u) => ({
          id: u.id,
          label: u.displayName,
          description: `${u.username}${u.email ? ` · ${u.email}` : ""}`,
          disabled: u.disabled,
          reason: u.disabled ? "Directory account disabled" : undefined,
        }));
      return (await clients.pocket.groups()).map((g) => {
        const reason = clients.protectedPocketGroups?.includes(g.name)
          ? "Grants privileged portal roles"
          : g.ldapId
            ? "Externally managed group"
            : undefined;
        return {
          id: g.id,
          label: g.friendlyName || g.name,
          description: g.name,
          disabled: !!reason,
          reason,
        };
      });
    }
    if (kind.startsWith("netbird-")) {
      requirePermission(actor, "network.manage");
      invariant(clients.netbird, "provider_not_configured", 503);
      if (kind === "netbird-users")
        return (await clients.netbird.users()).map((u) => ({
          id: u.id,
          label: u.name,
          description: u.email,
          disabled: u.is_blocked,
          reason: u.is_blocked ? "NetBird account blocked" : undefined,
        }));
      if (kind === "netbird-peers")
        return (await clients.netbird.peers()).map((p) => ({
          id: p.id,
          label: p.name,
          description: p.ip,
        }));
      if (kind === "netbird-networks")
        return options(await clients.netbird.networks(), (n) =>
          String(n.name ?? n.id),
        );
      if (kind === "netbird-resources") {
        invariant(query.networkId, "network_required");
        // Apply the same optional-API capability boundary as network discovery.
        invariant(
          clients.netbird.capabilities["netbird.networks"],
          "unsupported",
          503,
        );
        return (await clients.netbird.resources(query.networkId)).map((r) => ({
          id: r.id,
          label: String(r.name ?? r.id),
          description: String(r.address ?? ""),
        }));
      }
      if (kind === "netbird-groups") {
        const purpose = z
          .enum(["policy", "binding", "enrollment", "resource"])
          .parse(query.purpose ?? "policy");
        const managed =
          purpose === "enrollment"
            ? new Set(
                (
                  await db.query(
                    "SELECT external_id FROM bindings WHERE provider='netbird' AND managed",
                  )
                ).map((b) => b.external_id),
              )
            : undefined;
        return (await clients.netbird.groups()).map((g) => {
          const reason =
            purpose !== "resource" && g.name === "All"
              ? "The All group cannot be used for this action"
              : purpose === "binding" && g.issued && g.issued !== "api"
                ? "Externally managed group"
                : managed && !managed.has(g.id)
                  ? "Not a Portcullis-managed enrollment group"
                  : undefined;
          return {
            id: g.id,
            label: g.name,
            description: g.issued,
            disabled: !!reason,
            reason,
          };
        });
      }
    }
    invariant(false, "not_found", 404);
  });
  app.get("/api/admin/users/:id/roles", async (request) => {
    requirePermission(request.actor, "*");
    const id = z.uuid().parse((request.params as { id: string }).id);
    const [user] = await db.query("SELECT id,name FROM users WHERE id=$1", [
      id,
    ]);
    invariant(user, "not_found", 404);
    return {
      user,
      editable: request.actor.id !== id,
      roles: await db.query(
        "SELECT role,scope,source FROM roles WHERE user_id=$1 ORDER BY source,role,scope",
        [id],
      ),
    };
  });
}
