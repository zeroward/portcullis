import { z } from "zod";
import { ProviderError } from "./http.js";
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
  configSchema = z.object({ instructions: z.string().default("") });
  secretReferences = [];
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
  override capabilities: Capability[] = [];
  override async operation(
    _capability: Capability,
    _input: unknown,
  ): Promise<ProviderResult<unknown>> {
    return {
      state: "awaiting-specification",
      reason: "Awaiting API specification",
    };
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
export function serviceProviders(production: boolean, mocks = false) {
  return [
    new ManualServiceProvider(),
    new WowManagerProvider(),
    ...(mocks ? [new MockServiceProvider(production)] : []),
  ];
}
