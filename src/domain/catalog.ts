import { z } from "zod";
import type { Database, Queryable, Transaction } from "../db/index.js";
import {
  can,
  requirePermission,
  hasServiceAccess,
  type Actor,
} from "./authorization.js";
import { invariant } from "../errors.js";
import { safeUrl } from "../security.js";
import { audit } from "./audit.js";
const url = z
  .string()
  .max(2048)
  .refine((s) => {
    try {
      safeUrl(s);
      return true;
    } catch {
      return false;
    }
  });
const launch = z
  .string()
  .max(2048)
  .refine((s) => {
    try {
      safeUrl(s, true);
      return true;
    } catch {
      return false;
    }
  });
export const serviceInput = z
  .object({
    name: z.string().min(2).max(100),
    slug: z.string().regex(/^[a-z0-9-]{2,80}$/),
    summary: z.string().max(240),
    visibility: z.enum(["discoverable", "entitled", "admin"]),
    metadata: z
      .object({
        type: z.enum(["game", "service"]).default("service"),
        category: z.string().max(80).default("Community"),
        tags: z.array(z.string().max(40)).max(12).default([]),
        description: z.string().max(40000).default(""),
        instructions: z.string().max(20000).default(""),
        owner: z.string().max(100).optional(),
        sortOrder: z.number().int().default(0),
        provider: z.enum(["manual", "wow-manager", "mock"]).default("manual"),
        version: z.string().max(100).default(""),
        environment: z.string().max(100).default(""),
        icon: url.optional(),
        cover: url.optional(),
        screenshots: z.array(url).max(6).default([]),
        source: z
          .object({ provider: z.literal("rawg"), url })
          .strict()
          .optional(),
        requiredClient: z.string().max(500).default(""),
        rules: z.string().max(10000).default(""),
        endpoints: z
          .array(
            z.object({
              label: z.string().max(100),
              host: z.string().regex(/^[a-zA-Z0-9.:\[\]-]{1,253}$/),
              protocol: z.enum(["tcp", "udp", "https", "http", "rdp"]),
              ports: z.array(z.number().int().min(1).max(65535)).min(1).max(16),
              network: z.enum(["public", "lan", "netbird"]),
              launch: launch.optional(),
            }),
          )
          .max(12)
          .default([]),
        links: z
          .array(
            z.object({
              label: z.string().max(100),
              url,
              admin: z.boolean().default(false),
            }),
          )
          .max(12)
          .default([]),
      })
      .strict(),
    entitlementIds: z.array(z.uuid()).default([]),
    dependencies: z
      .array(z.object({ id: z.uuid(), required: z.boolean() }))
      .default([]),
    version: z.number().int().optional(),
  })
  .strict();
export class Catalog {
  constructor(
    readonly db: Database,
    readonly production = false,
  ) {}
  async cards(actor: Actor) {
    const rows = await this.db.query(
      "SELECT * FROM services ORDER BY (metadata->>'sortOrder')::integer NULLS LAST,name",
    );
    const cards = [];
    for (const s of rows) {
      const filtered = await this.project(actor, s);
      if (filtered) cards.push(filtered);
    }
    return cards;
  }
  async project(actor: Actor, s: any) {
    const admin = can(actor, "catalog.manage", s.id);
    const access = await hasServiceAccess(this.db, actor.id, s.id);
    if (
      (s.visibility === "admin" && !admin) ||
      (s.visibility === "entitled" && !access && !admin)
    )
      return null;
    const requirements = await this.db.query(
      "SELECT e.id,e.name,e.key,e.policy->>'requestable' AS requestable FROM entitlements e JOIN service_entitlements se ON se.entitlement_id=e.id WHERE se.service_id=$1",
      [s.id],
    );
    const favorite = !!(
      await this.db.query(
        "SELECT 1 FROM favorites WHERE user_id=$1 AND service_id=$2",
        [actor.id, s.id],
      )
    ).length;
    const state = await healthSummary(this.db, s.id);
    const base = {
      id: s.id,
      name: s.name,
      slug: s.slug,
      summary: s.summary,
      visibility: s.visibility,
      category: s.metadata.category,
      type: s.metadata.type,
      tags: s.metadata.tags ?? [],
      cover: s.metadata.cover,
      icon: s.metadata.icon,
      source: s.metadata.source,
      favorite,
      health:
        access || admin
          ? state
          : {
              ...state,
              observations: [],
              maintenance: state.maintenance.map((m) => ({
                ...m,
                title: "Scheduled maintenance",
              })),
            },
      access: access ? "active" : "required",
      requirements,
      canManage: admin,
      version: s.version,
    };
    if (!access && !admin) return base;
    return {
      ...base,
      incidents: await this.db.query(
        "SELECT id,title,state FROM incidents WHERE (service_id=$1 OR service_id IS NULL) AND state<>'resolved' ORDER BY created_at DESC",
        [s.id],
      ),
      announcements: await this.db.query(
        "SELECT id,title,body FROM announcements WHERE service_id=$1 OR service_id IS NULL ORDER BY created_at DESC LIMIT 5",
        [s.id],
      ),
      ...(admin
        ? {
            dependencies: await this.db.query(
              "SELECT dependency_id AS id,required FROM service_dependencies WHERE service_id=$1 ORDER BY dependency_id",
              [s.id],
            ),
          }
        : {}),
      metadata: {
        ...s.metadata,
        links: (s.metadata.links ?? []).filter((l: any) => !l.admin || admin),
      },
      access: access ? "active" : "administrative-preview",
    };
  }
  async detail(actor: Actor, id: string) {
    const [s] = await this.db.query("SELECT * FROM services WHERE id=$1", [id]);
    invariant(s, "not_found", 404);
    const r = await this.project(actor, s);
    invariant(r, "not_found", 404);
    return r;
  }
  async save(actor: Actor, input: unknown, id?: string) {
    requirePermission(actor, "catalog.manage", id ?? "*");
    const data = serviceInput.parse(input);
    return this.db.transaction((tx) => this.persist(tx, actor, data, id));
  }
  async createWith<T>(
    actor: Actor,
    input: unknown,
    afterCreate: (tx: Transaction, service: any) => Promise<T>,
  ) {
    requirePermission(actor, "catalog.manage");
    const data = serviceInput.parse(input);
    return this.db.transaction(async (tx) => {
      const service = await this.persist(tx, actor, data);
      const result = await afterCreate(tx, service);
      return { service, result };
    });
  }
  private async persist(
    tx: Transaction,
    actor: Actor,
    data: z.infer<typeof serviceInput>,
    id?: string,
  ) {
    invariant(
      data.visibility !== "entitled" || data.entitlementIds.length > 0,
      "entitled_visibility_requires_entitlements",
    );
    invariant(
      !this.production || data.metadata.provider !== "mock",
      "mock_forbidden",
    );
    // Serialize graph edits so concurrent, individually valid edits cannot form a cycle.
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtext('service-dependencies'))",
    );
    let row;
    if (id) {
      [row] = await tx.query(
        "UPDATE services SET name=$1,slug=$2,summary=$3,visibility=$4,metadata=$5,version=version+1 WHERE id=$6 AND version=$7 RETURNING *",
        [
          data.name,
          data.slug,
          data.summary,
          data.visibility,
          JSON.stringify(data.metadata),
          id,
          data.version,
        ],
      );
      invariant(row, "version_conflict", 409);
    } else
      [row] = await tx.query(
        "INSERT INTO services(name,slug,summary,visibility,metadata) VALUES ($1,$2,$3,$4,$5) RETURNING *",
        [
          data.name,
          data.slug,
          data.summary,
          data.visibility,
          JSON.stringify(data.metadata),
        ],
      );
    await tx.query("DELETE FROM service_entitlements WHERE service_id=$1", [
      row.id,
    ]);
    for (const e of data.entitlementIds)
      await tx.query("INSERT INTO service_entitlements VALUES ($1,$2)", [
        row.id,
        e,
      ]);
    await tx.query("DELETE FROM service_dependencies WHERE service_id=$1", [
      row.id,
    ]);
    for (const d of data.dependencies)
      await tx.query("INSERT INTO service_dependencies VALUES ($1,$2,$3)", [
        row.id,
        d.id,
        d.required,
      ]);
    const cycle = await tx.query(
      `WITH RECURSIVE walk(node,path,cycle) AS (SELECT dependency_id,ARRAY[service_id,dependency_id],service_id=dependency_id FROM service_dependencies WHERE service_id=$1 UNION ALL SELECT d.dependency_id,w.path||d.dependency_id,d.dependency_id=ANY(w.path) FROM walk w JOIN service_dependencies d ON d.service_id=w.node WHERE NOT w.cycle) SELECT 1 FROM walk WHERE cycle LIMIT 1`,
      [row.id],
    );
    invariant(!cycle.length, "dependency_cycle");
    await audit(
      tx,
      actor.id,
      id ? "service.update" : "service.create",
      row.id,
      data,
    );
    return row;
  }
  async remove(actor: Actor, id: string) {
    requirePermission(actor, "catalog.manage", id);
    await this.db.transaction(async (tx) => {
      await tx.query("DELETE FROM services WHERE id=$1", [id]);
      await audit(tx, actor.id, "service.delete", id);
    });
  }
}
export async function healthSummary(db: Queryable, id: string) {
  const rows = await db.query(
    `SELECT o.state,o.expires_at,o.observed_at,o.vantage,o.source FROM health_checks c LEFT JOIN LATERAL (SELECT * FROM health_observations WHERE check_id=c.id ORDER BY observed_at DESC LIMIT 1) o ON true WHERE c.service_id=$1 AND c.enabled`,
    [id],
  );
  const states = rows.map((r) =>
    !r.state
      ? "unknown"
      : new Date(r.expires_at) < new Date()
        ? "stale"
        : r.state,
  );
  const measuredState = summarizeHealth(states);
  // A path is required only when every edge is required. An optional dependency
  // failure degrades its parent, even when a deeper dependency is required.
  // Read cached observations only; never poll a provider while rendering cards.
  const dependencies = await db.query(
    `WITH RECURSIVE dependencies(id,required,path) AS (
    SELECT dependency_id,required,ARRAY[service_id,dependency_id]
    FROM service_dependencies WHERE service_id=$1
    UNION ALL
    SELECT d.dependency_id,p.required AND d.required,p.path||d.dependency_id
    FROM dependencies p JOIN service_dependencies d ON d.service_id=p.id
    WHERE NOT d.dependency_id=ANY(p.path)
  ), reachable AS (SELECT id,bool_or(required) AS required FROM dependencies GROUP BY id)
  SELECT r.id,r.required,o.state,o.expires_at FROM reachable r
  LEFT JOIN health_checks c ON c.service_id=r.id AND c.enabled
  LEFT JOIN LATERAL (SELECT state,expires_at FROM health_observations WHERE check_id=c.id
    ORDER BY observed_at DESC LIMIT 1) o ON true`,
    [id],
  );
  const dependencyStates = dependencies.map((r) => {
    const observed = !r.state
      ? "unknown"
      : new Date(r.expires_at) < new Date()
        ? "stale"
        : r.state;
    return !r.required && observed === "down" ? "degraded" : observed;
  });
  const state = summarizeHealth([measuredState, ...dependencyStates]);
  const maintenance = await db.query(
    "SELECT title,starts_at,ends_at FROM maintenance WHERE (service_id=$1 OR service_id IS NULL) AND starts_at<=now() AND ends_at>now()",
    [id],
  );
  return {
    state,
    measuredState,
    dependencyState: dependencies.length
      ? summarizeHealth(dependencyStates)
      : null,
    maintenance,
    observations: rows.map((r) => ({
      state: r.state ?? "unknown",
      observedAt: r.observed_at,
      expiresAt: r.expires_at,
      vantage: r.vantage ?? null,
      source: r.source ?? null,
    })),
    meaning: "Monitor reachability; not connectivity from your computer",
  };
}
function summarizeHealth(states: string[]) {
  return (
    ["down", "degraded", "stale", "unknown"].find((s) => states.includes(s)) ??
    (states.length ? "healthy" : "unknown")
  );
}
export function rdpFile(host: string, port: number) {
  invariant(
    /^[a-zA-Z0-9.:[\]-]{1,253}$/.test(host) &&
      Number.isInteger(port) &&
      port > 0 &&
      port <= 65535,
    "invalid_rdp",
  );
  return `full address:s:${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}\r\nprompt for credentials:i:1\r\nauthentication level:i:2\r\n`;
}
