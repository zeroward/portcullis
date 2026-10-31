import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import ipaddr from "ipaddr.js";
import { z } from "zod";
import type { Config } from "./config.js";
import type { Database, Queryable } from "./db/index.js";
import { invariant } from "./errors.js";
import { requirePermission, type Actor } from "./domain/authorization.js";
import { audit, notify } from "./domain/audit.js";
import { hasServiceAccess } from "./domain/authorization.js";
import {
  waygateDashboardResponse,
  waygateStatusResponse,
  waygateToken,
  summarizeWaygateHealth,
} from "./providers/waygate.js";
import {
  PterodactylClient,
  summarizePterodactylHealth,
} from "./providers/pterodactyl.js";
export function allowedAddress(address: string, config: Config) {
  let ip = ipaddr.process(address);
  if (ip.kind() === "ipv6" && (ip as ipaddr.IPv6).isIPv4MappedAddress())
    ip = (ip as ipaddr.IPv6).toIPv4Address();
  const range = ip.range();
  if (
    ["linkLocal", "multicast", "broadcast", "unspecified", "reserved"].includes(
      range,
    ) ||
    address === "169.254.169.254"
  )
    return false;
  if (range === "loopback" && config.NODE_ENV === "production") return false;
  return config.MONITOR_ALLOWED_CIDRS.split(",")
    .filter(Boolean)
    .some((c) => {
      try {
        const [subnet, bits] = ipaddr.parseCIDR(c.trim());
        return ip.kind() === subnet.kind() && ip.match(subnet, bits);
      } catch {
        return false;
      }
    });
}
export async function resolveTarget(
  host: string,
  port: number,
  config: Config,
) {
  const waygateUrl = config.WAYGATE_URL ? new URL(config.WAYGATE_URL) : null;
  const isWaygateOrigin =
    waygateUrl !== null &&
    waygateUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase() ===
      host.replace(/^\[|\]$/g, "").toLowerCase() &&
    Number(waygateUrl.port || (waygateUrl.protocol === "https:" ? 443 : 80)) ===
      port;
  invariant(
    isWaygateOrigin ||
      config.MONITOR_ALLOWED_PORTS.split(",").map(Number).includes(port),
    "monitor_port_rejected",
  );
  const addresses = net.isIP(host)
    ? [{ address: host, family: net.isIP(host) }]
    : await dns.lookup(host, { all: true });
  const domainApproved = config.MONITOR_ALLOWED_DOMAINS.split(",")
    .map((x) => x.trim().toLowerCase())
    .includes(host.toLowerCase());
  invariant(
    addresses.length &&
      addresses.every(
        (a) =>
          isWaygateOrigin ||
          allowedAddress(a.address, config) ||
          (domainApproved && ipaddr.process(a.address).range() === "unicast"),
      ),
    "monitor_target_rejected",
  );
  return addresses[0];
}
function safeTcpAddress(address: string, config: Config) {
  let ip = ipaddr.process(address);
  if (ip.kind() === "ipv6" && (ip as ipaddr.IPv6).isIPv4MappedAddress())
    ip = (ip as ipaddr.IPv6).toIPv4Address();
  const range = ip.range();
  const normalized = ip.toString();
  return (
    ![
      "linkLocal",
      "multicast",
      "broadcast",
      "unspecified",
      "reserved",
    ].includes(range) &&
    !["169.254.169.254", "100.100.100.200", "fd00:ec2::254"].includes(
      normalized,
    ) &&
    (range !== "loopback" || config.NODE_ENV !== "production")
  );
}
export async function resolveTcpTarget(host: string, config: Config) {
  const addresses = net.isIP(host)
    ? [{ address: host, family: net.isIP(host) }]
    : await dns.lookup(host, { all: true });
  invariant(
    addresses.length &&
      addresses.every((a) => safeTcpAddress(a.address, config)),
    "monitor_target_rejected",
  );
  return addresses[0];
}

type ServiceMetadata = {
  type?: string;
  endpoints?: Array<{
    host?: string;
    protocol?: string;
    ports?: number[];
  }>;
};
function normalizedHost(host: string) {
  return host
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
}
export function matchesTcpEndpoint(
  metadata: ServiceMetadata | undefined,
  host: string,
  port: number,
) {
  return !!metadata?.endpoints?.some(
    (endpoint) =>
      endpoint.host &&
      normalizedHost(endpoint.host) === normalizedHost(host) &&
      ["tcp", "rdp"].includes(endpoint.protocol ?? "") &&
      endpoint.ports?.includes(port),
  );
}
export async function checkedHttp(
  urlString: string,
  config: Config,
  headers: Record<string, string> = {},
  timeout = 5000,
) {
  const url = new URL(urlString);
  invariant(
    ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password,
    "monitor_url_rejected",
  );
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const resolved = await resolveTarget(
    url.hostname.replace(/^\[|\]$/g, ""),
    port,
    config,
  );
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = (url.protocol === "https:" ? https : http).request(
      url,
      {
        headers,
        lookup: (_h, _o, cb) => cb(null, resolved.address, resolved.family),
        timeout,
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
          res.destroy();
          reject(new Error("redirect_rejected"));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (b) => {
          size += b.length;
          if (size > 1024 * 1024) {
            res.destroy(new Error("response_limit"));
          } else chunks.push(b);
        });
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("monitor_timeout")));
    req.on("error", reject);
    req.end();
  });
}
export function parseKuma(body: string, name: string) {
  const line = body
    .split("\n")
    .find(
      (l) =>
        l.startsWith("monitor_status{") &&
        l.includes(`monitor_name="${name.replaceAll('"', '\\"')}"`),
    );
  if (!line) return "unknown";
  const value = Number(
    line
      .slice(line.lastIndexOf("}") + 1)
      .trim()
      .split(" ")[0],
  );
  return value === 1
    ? "healthy"
    : value === 0
      ? "down"
      : value === 2
        ? "unknown"
        : value === 3
          ? "degraded"
          : "unknown";
}
export function parseWaygate(body: string): {
  state: "healthy" | "degraded" | "down" | "unknown";
  detail: Record<string, unknown>;
} {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { state: "unknown", detail: { error: "invalid_waygate_json" } };
  }
  const dash = waygateDashboardResponse.safeParse(json);
  if (dash.success) {
    const summary = summarizeWaygateHealth(dash.data);
    return {
      state: summary.state,
      detail: {
        realmName: summary.realmName,
        realmUp: summary.realmUp,
        coreName: summary.coreName,
        expansion: summary.expansion,
        worldVersion: summary.worldVersion,
        population: summary.population,
        onlinePlayers: summary.onlinePlayers,
        detectedModules: summary.detectedModules,
        demo: summary.demo,
        partial: summary.partial,
        cacheTtlSeconds: summary.cacheTtlSeconds,
        generatedAt: summary.generatedAt,
        errors: summary.errors.map((e) => ({
          section: e.section,
          code: e.code,
        })),
      },
    };
  }
  const statusOnly = waygateStatusResponse.safeParse(json);
  if (statusOnly.success) {
    return {
      state: statusOnly.data.data.realm_up ? "healthy" : "down",
      detail: {
        realmName: statusOnly.data.data.realm_name,
        realmUp: statusOnly.data.data.realm_up,
        coreName: statusOnly.data.data.core_name,
        expansion: statusOnly.data.data.expansion,
        worldVersion: statusOnly.data.data.world_version,
        population: statusOnly.data.data.population,
        demo: statusOnly.data.demo,
        partial: false,
        cacheTtlSeconds: statusOnly.data.cache_ttl_seconds,
        generatedAt: statusOnly.data.generated_at,
        errors: [],
      },
    };
  }
  return { state: "unknown", detail: { error: "invalid_waygate_contract" } };
}
export const checkDefinitionInput = z
  .object({
    kind: z.enum([
      "http",
      "tcp",
      "manual",
      "kuma",
      "waygate",
      "incoming",
      "pterodactyl",
    ]),
    intervalSeconds: z.number().int().min(5).max(86400).default(60),
    config: z
      .object({
        url: z.url().optional(),
        host: z.string().max(253).optional(),
        port: z.number().int().min(1).max(65535).optional(),
        expectedStatus: z.number().int().min(100).max(599).optional(),
        monitorName: z.string().max(200).optional(),
        serverIdentifier: z.string().min(1).max(64).optional(),
        secretReference: z.uuid().optional(),
        vantage: z.string().max(120).default("Portcullis worker"),
      })
      .strict(),
  })
  .strict();
export const checkInput = checkDefinitionInput.extend({ serviceId: z.uuid() });
export type CheckDefinition = z.infer<typeof checkDefinitionInput>;
export class Monitoring {
  constructor(
    readonly db: Database,
    readonly config: Config,
    readonly getSecret: (id: string) => Promise<string>,
    readonly pterodactyl?: PterodactylClient,
  ) {}
  async prepare(
    input: unknown,
    serviceMetadata?: ServiceMetadata,
  ): Promise<CheckDefinition> {
    const d = checkDefinitionInput.parse(input);
    if (d.kind === "waygate" && !d.config.url && this.config.WAYGATE_URL) {
      d.config.url = this.config.WAYGATE_URL;
    }
    if (["http", "kuma", "waygate"].includes(d.kind)) {
      invariant(d.config.url, "url_required");
      const u = new URL(d.config.url);
      invariant(
        ["http:", "https:"].includes(u.protocol) && !u.username && !u.password,
        "invalid_url",
      );
      await resolveTarget(
        u.hostname,
        Number(u.port || (u.protocol === "https:" ? 443 : 80)),
        this.config,
      );
      if (d.kind === "http") d.config.expectedStatus ??= 200;
    }
    if (d.kind === "tcp") {
      invariant(d.config.host && d.config.port, "target_required");
      invariant(
        matchesTcpEndpoint(serviceMetadata, d.config.host, d.config.port),
        "tcp_target_must_match_service_endpoint",
      );
      await resolveTcpTarget(d.config.host, this.config);
    }
    if (d.kind === "pterodactyl") {
      invariant(serviceMetadata?.type === "game", "game_service_required");
      const pterodactyl = this.pterodactyl;
      invariant(pterodactyl, "provider_not_configured", 503);
      invariant(pterodactyl.isConfigured(), "provider_not_configured", 503);
      invariant(d.config.serverIdentifier, "server_identifier_required");
      await pterodactyl.resources(d.config.serverIdentifier);
    }
    if (d.kind === "kuma")
      invariant(d.config.monitorName, "monitor_name_required");
    if (d.kind === "waygate") {
      const key = d.config.secretReference
        ? await this.getSecret(d.config.secretReference)
        : (this.config.WAYGATE_TOKEN ?? this.config.MANAGEMENT_API_TOKEN ?? "");
      invariant(
        waygateToken.safeParse(key).success,
        "waygate_credentials_required",
      );
    }
    if (d.kind === "incoming")
      invariant(this.config.HEALTH_WEBHOOK_KEY, "webhook_disabled", 503);
    return d;
  }
  async createPrepared(
    db: Queryable,
    actor: Actor,
    serviceId: string,
    d: CheckDefinition,
  ) {
    const [c] = await db.query(
      "INSERT INTO health_checks(service_id,kind,config,interval_seconds) VALUES ($1,$2,$3,$4) RETURNING *",
      [serviceId, d.kind, JSON.stringify(d.config), d.intervalSeconds],
    );
    await audit(db, actor.id, "monitor.create", c.id, { kind: d.kind });
    return c;
  }
  async save(actor: Actor, input: unknown) {
    const parsed = checkInput.parse(input);
    requirePermission(actor, "monitor.manage", parsed.serviceId);
    const [service] = await this.db.query(
      "SELECT metadata FROM services WHERE id=$1",
      [parsed.serviceId],
    );
    invariant(service, "not_found", 404);
    const d = await this.prepare(
      {
        kind: parsed.kind,
        intervalSeconds: parsed.intervalSeconds,
        config: parsed.config,
      },
      service.metadata,
    );
    return this.createPrepared(this.db, actor, parsed.serviceId, d);
  }
  async poll(id: string) {
    const [c] = await this.db.query(
      `SELECT c.*,s.metadata AS service_metadata
       FROM health_checks c
       JOIN services s ON s.id=c.service_id
       WHERE c.id=$1 AND c.enabled`,
      [id],
    );
    if (!c) return;
    let state: string = "unknown";
    let detail = {};
    try {
      if (c.kind === "http") {
        const r = await checkedHttp(c.config.url, this.config);
        state =
          r.status === (c.config.expectedStatus ?? 200) ? "healthy" : "down";
        detail = { status: r.status };
      }
      if (c.kind === "kuma") {
        const key = c.config.secretReference
          ? await this.getSecret(c.config.secretReference)
          : null;
        const r = await checkedHttp(
          c.config.url,
          this.config,
          key
            ? {
                Authorization: `Basic ${Buffer.from(`:${key}`).toString("base64")}`,
              }
            : {},
        );
        state =
          r.status === 200
            ? parseKuma(r.body, c.config.monitorName)
            : "unknown";
      }
      if (c.kind === "waygate") {
        const key = c.config.secretReference
          ? await this.getSecret(c.config.secretReference)
          : (this.config.WAYGATE_TOKEN ??
            this.config.MANAGEMENT_API_TOKEN ??
            "");
        if (!waygateToken.safeParse(key).success) {
          state = "unknown";
          detail = { error: "missing_or_invalid_waygate_token" };
        } else {
          const base = String(c.config.url ?? this.config.WAYGATE_URL ?? "")
            .split("?")[0]
            .replace(/\/$/, "");
          const targetUrl =
            base.endsWith("/api/v1/dashboard") ||
            base.endsWith("/api/v1/status")
              ? base
              : `${base}/api/v1/dashboard`;
          const r = await checkedHttp(
            targetUrl,
            this.config,
            {
              Authorization: `Bearer ${key}`,
              Accept: "application/json",
            },
            10000,
          );
          if (r.status === 200) {
            const parsed = parseWaygate(r.body);
            state = parsed.state;
            detail = parsed.detail;
          } else {
            state = r.status === 503 ? "down" : "unknown";
            detail = { status: r.status };
          }
        }
      }
      if (c.kind === "tcp") {
        invariant(
          matchesTcpEndpoint(c.service_metadata, c.config.host, c.config.port),
          "tcp_target_must_match_service_endpoint",
        );
        const address = await resolveTcpTarget(c.config.host, this.config);
        await new Promise<void>((resolve, reject) => {
          const socket = net.connect({
            host: address.address,
            port: c.config.port,
          });
          socket.setTimeout(5000);
          socket.once("connect", () => {
            socket.destroy();
            resolve();
          });
          socket.once("timeout", () => {
            socket.destroy();
            reject(new Error("timeout"));
          });
          socket.once("error", reject);
        });
        state = "healthy";
      }
      if (c.kind === "pterodactyl") {
        const pterodactyl = this.pterodactyl;
        invariant(pterodactyl, "provider_not_configured");
        invariant(pterodactyl.isConfigured(), "provider_not_configured");
        const snapshot = await pterodactyl.resources(c.config.serverIdentifier);
        const summary = summarizePterodactylHealth(snapshot);
        state = summary.state;
        detail = summary.detail;
      }
    } catch (e) {
      state = [
        "ECONNREFUSED",
        "ETIMEDOUT",
        "EHOSTUNREACH",
        "ENETUNREACH",
      ].includes((e as any).code)
        ? "down"
        : "unknown";
      detail = {
        error:
          state === "down"
            ? "target_unreachable_from_worker"
            : "monitor_unavailable_or_target_rejected",
      };
    }
    await this.observe(
      id,
      state,
      c.kind,
      c.config.vantage,
      c.interval_seconds * 3,
      detail,
    );
  }
  async observe(
    id: string,
    state: string,
    source: string,
    vantage: string,
    ttl: number,
    details: any = {},
  ) {
    await this.db.query(
      "INSERT INTO health_observations(check_id,state,source,vantage,expires_at,details) VALUES ($1,$2,$3,$4,now()+$5*interval '1 second',$6)",
      [id, state, source, vantage, ttl, JSON.stringify(details)],
    );
    const [check] = await this.db.query(
      "SELECT service_id FROM health_checks WHERE id=$1",
      [id],
    );
    const recent = await this.db.query(
      "SELECT state FROM health_observations WHERE check_id=$1 ORDER BY observed_at DESC LIMIT 3",
      [id],
    );
    // Display every measurement, but notify only after three agreeing observations.
    if (recent.length < 3 || recent.some((o) => o.state !== state)) return;
    if (
      (
        await this.db.query(
          "SELECT 1 FROM maintenance WHERE (service_id=$1 OR service_id IS NULL) AND starts_at<=now() AND ends_at>now()",
          [check.service_id],
        )
      ).length
    )
      return;
    await this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `health-alert:${id}`,
      ]);
      const [prior] = await tx.query(
        "SELECT value FROM settings WHERE key=$1",
        [`health.alert.${id}`],
      );
      if (prior?.value.state === state) return;
      const epoch = Date.now();
      await tx.query(
        "INSERT INTO settings(key,value) VALUES ($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",
        [`health.alert.${id}`, JSON.stringify({ state, epoch })],
      );
      for (const u of await tx.query(
        "SELECT id FROM users WHERE NOT suspended",
      ))
        if (await hasServiceAccess(tx, u.id, check.service_id))
          await notify(
            tx,
            u.id,
            state === "healthy" ? "health-recovery" : "health-alert",
            "Service health changed. See the portal for authorized details.",
            "/notices",
            `health:${id}:${epoch}:${u.id}`,
          );
    });
  }
}
