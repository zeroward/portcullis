import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database } from "../db/index.js";
import { Catalog, serviceInput } from "./catalog.js";
import { can, requirePermission, type Actor } from "./authorization.js";
import { invariant } from "../errors.js";
import type { PterodactylClient } from "../providers/pterodactyl.js";
import type { Monitoring } from "../monitoring.js";
import { safeUrl } from "../security.js";
import { ProviderError } from "../providers/http.js";
import { audit } from "./audit.js";

const presentation = z.object({
  name: z.string().trim().min(2).max(100),
  summary: z.string().max(240).default(""),
  description: z.string().max(40000).default(""),
  cover: z
    .string()
    .max(2048)
    .default("")
    .refine((v) => {
      try {
        if (v) safeUrl(v);
        return true;
      } catch {
        return false;
      }
    }),
  source: z
    .object({
      provider: z.literal("rawg"),
      url: z
        .string()
        .url()
        .refine((v) => {
          try {
            safeUrl(v);
            return true;
          } catch {
            return false;
          }
        }),
    })
    .nullable()
    .optional(),
});
const connection = z.object({
  host: z.string().regex(/^[a-zA-Z0-9.:\[\]-]{1,253}$/),
  port: z.number().int().min(1).max(65535),
});
const setup = z.object({
  submissionId: z.uuid(),
  games: z
    .array(
      z.object({
        key: z.string().min(1),
        id: z.uuid().optional(),
        presentation,
      }),
    )
    .min(1)
    .max(50),
  servers: z
    .array(
      z.object({
        gameKey: z.string(),
        name: z.string().trim().min(2).max(100),
        identifier: z.string().min(1).max(64).optional(),
        allocationId: z.number().int().optional(),
        connection: connection.optional(),
        override: connection.optional(),
        visibility: z.enum(["discoverable", "entitled", "admin"]),
        entitlementIds: z.array(z.uuid()).default([]),
        tcp: z.boolean().default(false),
        protocol: z.enum(["tcp", "udp"]).optional(),
        launch: z
          .string()
          .default("")
          .refine((v) => {
            try {
              if (v) safeUrl(v, true);
              return true;
            } catch {
              return false;
            }
          }),
      }),
    )
    .min(1)
    .max(50),
});
export class Games {
  private syncing: Promise<void> | undefined;
  constructor(
    readonly db: Database,
    readonly catalog: Catalog,
    readonly ptero: PterodactylClient | undefined,
    readonly instance: string,
    readonly monitoring: Monitoring,
  ) {
    this.instance = instance.replace(/\/$/, "");
  }
  async list(actor: Actor) {
    const servers = await this.catalog.cards(actor);
    const games = await this.db.query(
      "SELECT g.*, EXISTS(SELECT 1 FROM game_favorites f WHERE f.game_id=g.id AND f.user_id=$1) AS favorite FROM games g ORDER BY lower(g.presentation->>'name')",
      [actor.id],
    );
    const links = await this.db.query(
      "SELECT s.id,s.game_id,i.state,i.synced_at,i.connection_override,i.snapshot,i.allocation_id FROM services s LEFT JOIN game_imports i ON i.service_id=s.id WHERE s.game_id IS NOT NULL",
    );
    return games
      .map((g) => ({
        ...g,
        ...g.presentation,
        canManage: can(actor, "catalog.manage"),
        servers: servers
          .filter((s) => links.some((l) => l.id === s.id && l.game_id === g.id))
          .map((s) => {
            const link = links.find((l) => l.id === s.id);
            const allocations =
              link?.snapshot?.allocations ??
              link?.snapshot?.relationships?.allocations?.data?.map(
                (a: any) => a.attributes,
              ) ??
              [];
            const allocation =
              allocations.find((a: any) => a.id === link?.allocation_id) ??
              allocations.find((a: any) => a.is_default);
            return {
              ...s,
              sync: link?.state
                ? {
                    state: link.state,
                    syncedAt: link.synced_at,
                    ...(s.canManage
                      ? {
                          override: link.connection_override,
                          source: allocation
                            ? {
                                host: allocation.ip_alias || allocation.ip,
                                port: allocation.port,
                              }
                            : null,
                        }
                      : {}),
                  }
                : null,
            };
          }),
      }))
      .filter((g) => g.servers.length || g.canManage);
  }
  async detail(actor: Actor, id: string) {
    const g = (await this.list(actor)).find((g) => g.id === id);
    invariant(g, "not_found", 404);
    return g;
  }
  async edit(actor: Actor, id: string, input: unknown) {
    requirePermission(actor, "catalog.manage");
    const p = z
      .object({ presentation, version: z.number().int() })
      .parse(input);
    return this.db.transaction(async (tx) => {
      const [g] = await tx.query(
        "UPDATE games SET presentation=$1,version=version+1 WHERE id=$2 AND version=$3 RETURNING *",
        [JSON.stringify(p.presentation), id, p.version],
      );
      invariant(g, "version_conflict", 409);
      await audit(tx, actor.id, "game.update", id, p.presentation);
      return g;
    });
  }
  async favorite(actor: Actor, id: string, value: boolean) {
    await this.detail(actor, id);
    if (value)
      await this.db.query(
        "INSERT INTO game_favorites VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [actor.id, id],
      );
    else
      await this.db.query(
        "DELETE FROM game_favorites WHERE user_id=$1 AND game_id=$2",
        [actor.id, id],
      );
    return { ok: true };
  }
  async move(actor: Actor, server: string, game: string) {
    requirePermission(actor, "catalog.manage");
    await this.detail(actor, game);
    return this.db.transaction(async (tx) => {
      const rows = await tx.query(
        "UPDATE services SET game_id=$1,version=version+1 WHERE id=$2 AND game_id IS NOT NULL RETURNING id",
        [game, server],
      );
      invariant(rows.length, "not_found", 404);
      await audit(tx, actor.id, "game.server.move", server, { gameId: game });
      return { ok: true };
    });
  }
  async browse(actor: Actor) {
    requirePermission(actor, "catalog.manage");
    requirePermission(actor, "monitor.manage");
    invariant(this.ptero, "provider_not_configured", 503);
    await this.adoptLegacy();
    const imported = await this.db.query(
      "SELECT identifier,service_id FROM game_imports WHERE instance=$1",
      [this.instance],
    );
    return (await this.ptero.servers()).map((s) => ({
      identifier: s.identifier,
      name: s.name,
      description: s.description,
      allocations:
        s.relationships?.allocations.data.map((a) => a.attributes) ?? [],
      imported: imported.find((i) => i.identifier === s.identifier)?.service_id,
    }));
  }
  async publish(actor: Actor, input: unknown) {
    requirePermission(actor, "catalog.manage");
    const data = setup.parse(input);
    const [prior] = await this.db.query(
      "SELECT result FROM game_submissions WHERE id=$1 AND actor_id=$2",
      [data.submissionId, actor.id],
    );
    if (prior) return prior.result;
    invariant(
      new Set(data.games.map((g) => g.key)).size === data.games.length,
      "duplicate_game_key",
    );
    const inventory = data.servers.some((s) => s.identifier)
      ? await this.browse(actor)
      : [];
    const prepared: any[] = [];
    for (const s of data.servers) {
      invariant(
        data.games.some((g) => g.key === s.gameKey),
        "game_required",
      );
      const source = s.identifier
        ? inventory.find((i) => i.identifier === s.identifier)
        : undefined;
      if (s.identifier) {
        invariant(source, "server_unavailable");
        invariant(!source.imported, "server_already_imported", 409);
      }
      const allocation = source?.allocations.find((a) =>
        s.allocationId ? a.id === s.allocationId : a.is_default,
      );
      const address =
        s.override ??
        (source
          ? allocation
            ? {
                host: allocation.ip_alias || allocation.ip,
                port: allocation.port,
              }
            : undefined
          : s.connection);
      invariant(address, "connection_required");
      connection.parse(address);
      invariant(
        !["0.0.0.0", "::", "[::]"].includes(address.host),
        "player_address_required",
      );
      const check = s.identifier
        ? {
            kind: "pterodactyl",
            config: { serverIdentifier: s.identifier, vantage: "Pterodactyl" },
            intervalSeconds: 60,
          }
        : s.tcp
          ? {
              kind: "tcp",
              config: {
                host: address.host,
                port: address.port,
                vantage: "Portcullis worker",
              },
              intervalSeconds: 60,
            }
          : null;
      if (check) requirePermission(actor, "monitor.manage");
      prepared.push({
        s,
        source,
        allocation,
        address,
        check: check
          ? await this.monitoring.prepare(check, {
              type: "game",
              endpoints: [
                { host: address.host, ports: [address.port], protocol: "tcp" },
              ],
            })
          : null,
      });
    }
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('game-publish'))");
      const [existing] = await tx.query(
        "SELECT * FROM game_submissions WHERE id=$1",
        [data.submissionId],
      );
      if (existing) {
        invariant(existing.actor_id === actor.id, "submission_conflict", 409);
        return existing.result;
      }
      const ids: Record<string, string> = {};
      for (const g of data.games) {
        if (g.id) {
          invariant(
            (await tx.query("SELECT id FROM games WHERE id=$1", [g.id])).length,
            "game_not_found",
          );
          ids[g.key] = g.id;
        } else {
          const [row] = await tx.query(
            "INSERT INTO games(presentation) VALUES ($1) RETURNING id",
            [JSON.stringify(g.presentation)],
          );
          ids[g.key] = row.id;
        }
      }
      for (const p of prepared) {
        if (p.s.identifier)
          invariant(
            !(
              await tx.query(
                "SELECT 1 FROM game_imports WHERE instance=$1 AND identifier=$2",
                [this.instance, p.s.identifier],
              )
            ).length,
            "server_already_imported",
            409,
          );
        const record = serviceInput.parse({
          name: p.s.name,
          slug: `server-${randomUUID()}`,
          summary: "",
          visibility: p.s.visibility,
          entitlementIds: p.s.entitlementIds,
          metadata: {
            type: "game",
            endpoints: [
              {
                label: "Game connection",
                host: p.address.host,
                ports: [p.address.port],
                protocol: p.s.tcp ? "tcp" : (p.s.protocol ?? "unknown"),
                network: "public",
                ...(p.s.launch ? { launch: p.s.launch } : {}),
              },
            ],
          },
        });
        const row = await this.catalog.persist(
          tx,
          actor,
          record,
          undefined,
          ids[p.s.gameKey],
        );
        if (p.check)
          await this.monitoring.createPrepared(tx, actor, row.id, p.check);
        if (p.s.identifier)
          await tx.query(
            "INSERT INTO game_imports(service_id,instance,identifier,allocation_id,snapshot,connection_override,synced_at) VALUES ($1,$2,$3,$4,$5,$6,now())",
            [
              row.id,
              this.instance,
              p.s.identifier,
              p.allocation?.id,
              JSON.stringify(p.source),
              p.s.override ? JSON.stringify(p.s.override) : null,
            ],
          );
      }
      const result = { gameIds: [...new Set(Object.values(ids))] };
      await tx.query("INSERT INTO game_submissions VALUES ($1,$2,$3)", [
        data.submissionId,
        actor.id,
        JSON.stringify(result),
      ]);
      return result;
    });
  }
  async override(actor: Actor, id: string, input: unknown) {
    requirePermission(actor, "catalog.manage", id);
    const value = connection.nullable().parse(input);
    invariant(
      !value || !["0.0.0.0", "::", "[::]"].includes(value.host),
      "player_address_required",
    );
    const rows = await this.db.query(
      "UPDATE game_imports SET connection_override=$1 WHERE service_id=$2 RETURNING service_id",
      [value ? JSON.stringify(value) : null, id],
    );
    invariant(rows.length, "not_found", 404);
    await this.sync();
    return { ok: true };
  }
  sync(force = true): Promise<void> {
    return (this.syncing ??= this.performSync(force).finally(() => {
      this.syncing = undefined;
    }));
  }
  private async performSync(force: boolean) {
    if (!this.ptero) return;
    await this.db.withLock("game-sync", async () => {
      const key = `games.sync.${this.instance}`;
      const [last] = await this.db.query(
        "SELECT updated_at FROM settings WHERE key=$1",
        [key],
      );
      if (
        !force &&
        last &&
        Date.now() - new Date(last.updated_at).getTime() < 300000
      )
        return;
      await this.db.query(
        "INSERT INTO settings(key,value) VALUES ($1,'{}') ON CONFLICT(key) DO UPDATE SET updated_at=now()",
        [key],
      );
      await this.adoptLegacy();
      let inventory;
      try {
        inventory = await this.ptero!.servers();
      } catch (error) {
        await this.db.query(
          "UPDATE game_imports SET state=CASE WHEN state='unavailable' THEN state ELSE $2 END WHERE instance=$1",
          [
            this.instance,
            error instanceof ProviderError && error.code === "forbidden"
              ? "unavailable"
              : "stale",
          ],
        );
        return;
      }
      const imports = await this.db.query(
        "SELECT * FROM game_imports WHERE instance=$1",
        [this.instance],
      );
      for (const item of imports) {
        const source = inventory.find((s) => s.identifier === item.identifier);
        const allocations =
          source?.relationships?.allocations.data.map((a) => a.attributes) ??
          [];
        const allocation =
          allocations.find((a) => a.id === item.allocation_id) ??
          allocations.find((a) => a.is_default);
        const address =
          item.connection_override ??
          (allocation
            ? {
                host: allocation.ip_alias || allocation.ip,
                port: allocation.port,
              }
            : null);
        const valid =
          !!source &&
          !!address &&
          connection.safeParse(address).success &&
          !["0.0.0.0", "::", "[::]"].includes(address.host);
        await this.db.transaction(async (tx) => {
          await tx.query(
            "UPDATE game_imports SET state=$1,snapshot=$2,synced_at=now() WHERE service_id=$3",
            [
              valid ? "current" : "unavailable",
              JSON.stringify(source ?? {}),
              item.service_id,
            ],
          );
          if (valid)
            await tx.query(
              `UPDATE services SET metadata=jsonb_set(metadata,'{endpoints}',
                jsonb_build_array(coalesce(metadata#>'{endpoints,0}','{"label":"Game connection","protocol":"unknown","network":"public"}'::jsonb) || jsonb_build_object('host',$1::text,'ports',jsonb_build_array($2::integer))) || coalesce((metadata->'endpoints')-0,'[]'::jsonb)),version=version+1
                WHERE id=$3 AND (metadata#>>'{endpoints,0,host}' IS DISTINCT FROM $1 OR metadata#>'{endpoints,0,ports}' IS DISTINCT FROM jsonb_build_array($2::integer))`,
              [address.host, address.port, item.service_id],
            );
        });
      }
    });
  }
  private async adoptLegacy() {
    await this.db.query(
      `INSERT INTO game_imports(service_id,instance,identifier,connection_override)
      SELECT DISTINCT ON (c.config->>'serverIdentifier') c.service_id,$1,c.config->>'serverIdentifier',
      CASE WHEN s.metadata#>>'{endpoints,0,host}' IS NOT NULL THEN jsonb_build_object('host',s.metadata#>>'{endpoints,0,host}','port',s.metadata#>'{endpoints,0,ports,0}') ELSE NULL END
      FROM health_checks c JOIN services s ON s.id=c.service_id
      WHERE c.kind='pterodactyl' AND s.game_id IS NOT NULL AND c.config->>'serverIdentifier' IS NOT NULL
      ORDER BY c.config->>'serverIdentifier',c.service_id ON CONFLICT DO NOTHING`,
      [this.instance],
    );
  }
}
