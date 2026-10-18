import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import ipaddr from "ipaddr.js";
import { z } from "zod";
import type { Config } from "./config.js";
import type { Database } from "./db/index.js";
import { invariant } from "./errors.js";
import { requirePermission, type Actor } from "./domain/authorization.js";
import { audit, notify } from "./domain/audit.js";
import { hasServiceAccess } from "./domain/authorization.js";
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
  invariant(
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
          allowedAddress(a.address, config) ||
          (domainApproved && ipaddr.process(a.address).range() === "unicast"),
      ),
    "monitor_target_rejected",
  );
  return addresses[0];
}
export async function checkedHttp(
  urlString: string,
  config: Config,
  headers: Record<string, string> = {},
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
        timeout: 5000,
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
export const checkInput = z
  .object({
    serviceId: z.uuid(),
    kind: z.enum(["http", "tcp", "manual", "kuma", "incoming"]),
    intervalSeconds: z.number().int().min(30).max(86400).default(60),
    config: z
      .object({
        url: z.url().optional(),
        host: z.string().max(253).optional(),
        port: z.number().int().min(1).max(65535).optional(),
        expectedStatus: z.number().int().min(100).max(599).default(200),
        monitorName: z.string().max(200).optional(),
        secretReference: z.uuid().optional(),
        vantage: z.string().max(120).default("Portcullis worker"),
      })
      .strict(),
  })
  .strict();
export class Monitoring {
  constructor(
    readonly db: Database,
    readonly config: Config,
    readonly getSecret: (id: string) => Promise<string>,
  ) {}
  async save(actor: Actor, input: unknown) {
    const d = checkInput.parse(input);
    requirePermission(actor, "monitor.manage", d.serviceId);
    if (["http", "kuma"].includes(d.kind)) {
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
    }
    if (d.kind === "tcp") {
      invariant(d.config.host && d.config.port, "target_required");
      await resolveTarget(d.config.host, d.config.port, this.config);
    }
    const [c] = await this.db.query(
      "INSERT INTO health_checks(service_id,kind,config,interval_seconds) VALUES ($1,$2,$3,$4) RETURNING *",
      [d.serviceId, d.kind, JSON.stringify(d.config), d.intervalSeconds],
    );
    await audit(this.db, actor.id, "monitor.create", c.id, { kind: d.kind });
    return c;
  }
  async poll(id: string) {
    const [c] = await this.db.query(
      "SELECT * FROM health_checks WHERE id=$1 AND enabled",
      [id],
    );
    if (!c) return;
    let state: string = "unknown";
    let detail = {};
    try {
      if (c.kind === "http") {
        const r = await checkedHttp(c.config.url, this.config);
        state = r.status === c.config.expectedStatus ? "healthy" : "down";
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
      if (c.kind === "tcp") {
        const address = await resolveTarget(
          c.config.host,
          c.config.port,
          this.config,
        );
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
