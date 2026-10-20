import { z } from "zod";
import { ProviderError, ProviderHttp } from "./http.js";

export const waygateToken = z.string().regex(/^[\x21-\x7e]{32,}$/);

export const waygateTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/)
  .refine((s) => !Number.isNaN(Date.parse(s)));

export const waygateErrorCode = z.enum([
  "unauthorized",
  "not_found",
  "method_not_allowed",
  "internal_error",
  "status_unavailable",
  "players_unavailable",
  "leaderboards_unavailable",
  "modules_unavailable",
]);

export const waygateError = z.object({
  code: waygateErrorCode,
  message: z.string(),
});

export const waygateErrorResponse = z.object({
  error: waygateError,
});

export const waygateCollectionError = z.object({
  section: z.enum(["status", "players", "leaderboards", "modules"]),
  code: z.enum([
    "status_unavailable",
    "players_unavailable",
    "leaderboards_unavailable",
    "modules_unavailable",
  ]),
  message: z.string(),
});

export const waygatePopulation = z.object({
  humans: z.number().int().min(0),
  bots: z.number().int().min(0),
  gms: z.number().int().min(0),
  total: z.number().int().min(0),
  alliance: z.number().int().min(0),
  horde: z.number().int().min(0),
});

export const waygateStatus = z.object({
  realm_name: z.string(),
  realm_up: z.boolean(),
  core_name: z.string(),
  expansion: z.string(),
  world_version: z.string(),
  public_host: z.string(),
  public_auth_port: z.number().int(),
  public_world_port: z.number().int(),
  population: waygatePopulation,
});

export const waygatePlayer = z.object({
  name: z.string(),
  level: z.number().int().min(0),
  race: z.string(),
  race_id: z.number().int().min(0),
  class: z.string(),
  class_id: z.number().int().min(0),
  zone: z.string(),
  faction: z.string(),
});

export const waygateBoardRow = z.object({
  rank: z.number().int().min(1),
  name: z.string(),
  level: z.number().int().min(0),
  class: z.string(),
  value: z.string(),
  raw: z.number().int().min(0).max(4294967295),
});

export const waygateLeaderboards = z.object({
  playtime: z.array(waygateBoardRow),
  kills: z.array(waygateBoardRow),
  honor: z.array(waygateBoardRow),
  arena: z.array(waygateBoardRow),
  gold: z.array(waygateBoardRow),
});

export const waygateModule = z.object({
  id: z.string(),
  title: z.string(),
});

export const waygateDashboard = z.object({
  status: waygateStatus.nullable(),
  players: z.array(waygatePlayer).nullable(),
  leaderboards: waygateLeaderboards.nullable(),
  modules: z.array(waygateModule).nullable(),
});

export const waygateDashboardResponse = z.object({
  generated_at: waygateTimestamp,
  cache_ttl_seconds: z.number().int().min(5),
  demo: z.boolean(),
  partial: z.boolean(),
  data: waygateDashboard,
  errors: z.array(waygateCollectionError),
});

const dedicatedEnvelope = <T>(data: z.ZodType<T>) =>
  z.object({
    generated_at: waygateTimestamp,
    cache_ttl_seconds: z.number().int().min(5),
    demo: z.boolean(),
    partial: z.literal(false),
    data,
    errors: z.array(waygateCollectionError).max(0),
  });

export const waygateStatusResponse = dedicatedEnvelope(waygateStatus);
export const waygatePlayersResponse = dedicatedEnvelope(z.array(waygatePlayer));
export const waygateLeaderboardsResponse =
  dedicatedEnvelope(waygateLeaderboards);
export const waygateModulesResponse = dedicatedEnvelope(z.array(waygateModule));

export type WaygateDashboardResponse = z.infer<typeof waygateDashboardResponse>;
export type WaygateStatusResponse = z.infer<typeof waygateStatusResponse>;
export type WaygatePlayersResponse = z.infer<typeof waygatePlayersResponse>;
export type WaygateLeaderboardsResponse = z.infer<
  typeof waygateLeaderboardsResponse
>;
export type WaygateModulesResponse = z.infer<typeof waygateModulesResponse>;
export type WaygateResource =
  "dashboard" | "status" | "players" | "leaderboards" | "modules";

export function summarizeWaygateHealth(snapshot: WaygateDashboardResponse): {
  state: "healthy" | "degraded" | "down" | "unknown";
  realmName: string | null;
  realmUp: boolean | null;
  coreName: string | null;
  expansion: string | null;
  worldVersion: string | null;
  publicHost: string | null;
  publicAuthPort: number | null;
  publicWorldPort: number | null;
  population: z.infer<typeof waygatePopulation> | null;
  onlinePlayers: number | null;
  detectedModules: number | null;
  demo: boolean;
  partial: boolean;
  cacheTtlSeconds: number;
  generatedAt: string;
  errors: z.infer<typeof waygateCollectionError>[];
} {
  const status = snapshot.data.status;
  const state = !status
    ? "unknown"
    : !status.realm_up
      ? "down"
      : snapshot.partial || snapshot.errors.length > 0
        ? "degraded"
        : "healthy";
  return {
    state,
    realmName: status?.realm_name ?? null,
    realmUp: status?.realm_up ?? null,
    coreName: status?.core_name ?? null,
    expansion: status?.expansion ?? null,
    worldVersion: status?.world_version ?? null,
    publicHost: status?.public_host ?? null,
    publicAuthPort: status?.public_auth_port ?? null,
    publicWorldPort: status?.public_world_port ?? null,
    population: status?.population ?? null,
    onlinePlayers: snapshot.data.players?.length ?? null,
    detectedModules: snapshot.data.modules?.length ?? null,
    demo: snapshot.demo,
    partial: snapshot.partial,
    cacheTtlSeconds: snapshot.cache_ttl_seconds,
    generatedAt: snapshot.generated_at,
    errors: snapshot.errors,
  };
}

export class WaygateClient {
  readonly http: ProviderHttp;
  private readonly validToken: boolean;
  private inflightDashboard: Promise<WaygateDashboardResponse> | null = null;

  constructor(
    base: string,
    token: string,
    readonly capabilities: Record<string, boolean> = {},
  ) {
    this.validToken = waygateToken.safeParse(token).success;
    this.http = new ProviderHttp(
      "wow-manager",
      base,
      { Authorization: this.validToken ? `Bearer ${token}` : "" },
      10000,
    );
  }

  isConfigured() {
    return this.validToken;
  }

  dashboard(): Promise<WaygateDashboardResponse> {
    if (this.inflightDashboard) return this.inflightDashboard;
    const req = this.http
      .request("GET", "/api/v1/dashboard", waygateDashboardResponse)
      .finally(() => {
        this.inflightDashboard = null;
      });
    this.inflightDashboard = req;
    return req;
  }

  status(): Promise<WaygateStatusResponse> {
    return this.http.request("GET", "/api/v1/status", waygateStatusResponse);
  }

  players(): Promise<WaygatePlayersResponse> {
    return this.http.request("GET", "/api/v1/players", waygatePlayersResponse);
  }

  leaderboards(): Promise<WaygateLeaderboardsResponse> {
    return this.http.request(
      "GET",
      "/api/v1/leaderboards",
      waygateLeaderboardsResponse,
    );
  }

  modules(): Promise<WaygateModulesResponse> {
    return this.http.request("GET", "/api/v1/modules", waygateModulesResponse);
  }

  async head(resource: WaygateResource = "dashboard"): Promise<{
    status: number;
    cacheControl: string | null;
    contentLength: number;
  }> {
    if (!this.validToken)
      throw new ProviderError("missing-credentials", "wow-manager");
    let response: Response;
    try {
      response = await fetch(
        `${this.http.base.replace(/\/$/, "")}/api/v1/${resource}`,
        {
          method: "HEAD",
          headers: {
            ...this.http.headers,
            accept: "application/json",
          },
          signal: AbortSignal.timeout(this.http.timeout),
          redirect: "error",
        },
      );
    } catch {
      throw new ProviderError("timeout", "wow-manager", true);
    }
    if (!response.ok) {
      const code =
        response.status === 404
          ? "not-found"
          : response.status === 401 || response.status === 403
            ? "forbidden"
            : "unavailable";
      throw new ProviderError(
        code,
        "wow-manager",
        response.status === 429 || response.status >= 500,
      );
    }
    return {
      status: response.status,
      cacheControl: response.headers.get("cache-control"),
      contentLength: Number(response.headers.get("content-length") ?? 0),
    };
  }

  async diagnostics() {
    const snap = await this.dashboard();
    const summary = summarizeWaygateHealth(snap);
    return {
      provider: "wow-manager",
      reachable: true,
      ...summary,
      verification: "read-only-telemetry",
    };
  }
}
