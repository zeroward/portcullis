import { z } from "zod";
import { ProviderError } from "./http.js";
import {
  WaygateClient,
  summarizeWaygateHealth,
  type WaygateResource,
} from "./waygate.js";
export type Capability =
  | "information"
  | "status"
  | "player-count"
  | "component-health"
  | "provision-account"
  | "revoke-account"
  | "game-roles"
  | "start"
  | "stop"
  | "restart"
  | "logs"
  | "console-link";
export type ProviderResult<T> =
  | { state: "ok"; value: T }
  | {
      state:
        | "unsupported"
        | "missing-credentials"
        | "awaiting-specification"
        | "manual-required";
      reason: string;
    };
export interface IdentityProvider {
  users(): Promise<unknown[]>;
  groups(): Promise<unknown[]>;
  setMembership(
    group: string,
    user: string,
    present: boolean,
  ): Promise<unknown>;
}
export interface NetworkProvider {
  users(): Promise<unknown[]>;
  peers(): Promise<unknown[]>;
  groups(): Promise<unknown[]>;
}
export interface HealthProvider {
  observe(config: unknown): Promise<{
    state: "healthy" | "degraded" | "down" | "unknown";
    source: string;
    vantage: string;
  }>;
}
export interface NotificationProvider {
  deliver(input: {
    recipient: string;
    body: string;
    link: string;
  }): Promise<void>;
}
export interface ServiceProvider {
  id: string;
  contractVersion: 1;
  configSchema: z.ZodType;
  secretReferences: string[];
  capabilities: Capability[];
  actions: {
    id: string;
    permission: string;
    confirmation: boolean;
    input: z.ZodType;
  }[];
  timeoutMs: number;
  retry: { attempts: number; backoffMs: number };
  operation(
    capability: Capability,
    input: unknown,
  ): Promise<ProviderResult<unknown>>;
}
export class ManualServiceProvider implements ServiceProvider {
  id = "manual";
  contractVersion = 1 as const;
  configSchema: z.ZodType = z.object({ instructions: z.string().default("") });
  secretReferences: string[] = [];
  capabilities: Capability[] = ["information"];
  actions: ServiceProvider["actions"] = [];
  timeoutMs = 1000;
  retry = { attempts: 0, backoffMs: 0 };
  async operation(
    capability: Capability,
    input: unknown,
  ): Promise<ProviderResult<unknown>> {
    if (capability === "information")
      return { state: "ok", value: this.configSchema.parse(input) };
    if (["provision-account", "revoke-account"].includes(capability))
      return {
        state: "manual-required",
        reason: "An authorized administrator must attest fulfillment.",
      };
    return {
      state: "unsupported",
      reason: "Manual provider does not support this operation.",
    };
  }
}
export class WowManagerProvider extends ManualServiceProvider {
  override id = "wow-manager";
  override configSchema = z.object({
    url: z.url().optional(),
    resource: z
      .enum(["dashboard", "status", "players", "leaderboards", "modules"])
      .default("dashboard"),
    instructions: z.string().default(""),
  });
  override secretReferences = ["MANAGEMENT_API_TOKEN"];
  override capabilities: Capability[] = [
    "information",
    "status",
    "player-count",
    "component-health",
  ];
  override timeoutMs = 10000;
  override retry = { attempts: 1, backoffMs: 1000 };
  constructor(readonly client?: WaygateClient) {
    super();
  }
  override async operation(
    capability: Capability,
    input: unknown,
  ): Promise<ProviderResult<unknown>> {
    if (!this.capabilities.includes(capability)) {
      return {
        state: "awaiting-specification",
        reason: "Awaiting API specification",
      };
    }
    const parsed = z
      .object({
        url: z.url().optional(),
        token: z.string().optional(),
        resource: z
          .enum(["dashboard", "status", "players", "leaderboards", "modules"])
          .optional(),
      })
      .passthrough()
      .safeParse(input ?? {});
    const client =
      this.client ??
      (parsed.success && parsed.data.url && parsed.data.token
        ? new WaygateClient(parsed.data.url, parsed.data.token)
        : undefined);
    if (!client || !client.isConfigured()) {
      return {
        state: "missing-credentials",
        reason:
          "Configure WAYGATE_URL and MANAGEMENT_API_TOKEN (or WAYGATE_TOKEN) for Waygate Management API v1.",
      };
    }
    if (capability === "status") {
      return { state: "ok", value: await client.status() };
    }
    if (capability === "player-count") {
      const snap = await client.dashboard();
      return {
        state: "ok",
        value: {
          generated_at: snap.generated_at,
          cache_ttl_seconds: snap.cache_ttl_seconds,
          demo: snap.demo,
          partial: snap.partial,
          population: snap.data.status?.population ?? null,
          players: snap.data.players,
          errors: snap.errors,
        },
      };
    }
    if (capability === "component-health") {
      const snap = await client.dashboard();
      return {
        state: "ok",
        value: summarizeWaygateHealth(snap),
      };
    }
    const resource: WaygateResource =
      (parsed.success ? parsed.data.resource : undefined) ?? "dashboard";
    if (resource === "status")
      return { state: "ok", value: await client.status() };
    if (resource === "players")
      return { state: "ok", value: await client.players() };
    if (resource === "leaderboards")
      return { state: "ok", value: await client.leaderboards() };
    if (resource === "modules")
      return { state: "ok", value: await client.modules() };
    return { state: "ok", value: await client.dashboard() };
  }
}
export class MockServiceProvider extends ManualServiceProvider {
  override id = "mock";
  override capabilities: Capability[] = [
    "information",
    "status",
    "player-count",
    "provision-account",
    "revoke-account",
  ];
  constructor(production: boolean) {
    super();
    if (production) throw new ProviderError("forbidden", "mock");
  }
  override async operation(
    capability: Capability,
    input: unknown,
  ): Promise<ProviderResult<unknown>> {
    const d = z
      .object({
        delay: z.number().min(0).max(1000).default(0),
        fail: z.boolean().default(false),
      })
      .parse(input);
    await new Promise((resolve) => setTimeout(resolve, d.delay));
    if (d.fail) throw new ProviderError("unavailable", "mock", true);
    return this.capabilities.includes(capability)
      ? {
          state: "ok",
          value: {
            developmentOnly: true,
            players: capability === "player-count" ? 12 : null,
          },
        }
      : { state: "unsupported", reason: "Mock capability unavailable" };
  }
}
export function serviceProviders(
  production: boolean,
  mocks = false,
  waygate?: WaygateClient,
) {
  return [
    new ManualServiceProvider(),
    new WowManagerProvider(waygate),
    ...(mocks ? [new MockServiceProvider(production)] : []),
  ];
}
