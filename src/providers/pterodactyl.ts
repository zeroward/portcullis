import { z } from "zod";
import { ProviderError, ProviderHttp, pathId } from "./http.js";

const server = z.object({
  object: z.literal("server"),
  attributes: z.object({
    identifier: z.string().min(1).max(64),
    name: z.string().min(1).max(255),
    node: z.string().max(255).optional(),
    description: z.string().max(2000).optional(),
    relationships: z
      .object({
        allocations: z.object({
          data: z.array(
            z.object({
              attributes: z.object({
                id: z.number().int(),
                ip: z.string(),
                ip_alias: z.string().nullable(),
                port: z.number().int().min(1).max(65535),
                is_default: z.boolean(),
              }),
            }),
          ),
        }),
      })
      .optional(),
  }),
});
const serverList = z.object({
  object: z.literal("list"),
  data: z.array(server),
  meta: z.object({
    pagination: z.object({
      current_page: z.number().int().min(1),
      total_pages: z.number().int().min(1),
    }),
  }),
});
export const pterodactylResources = z.object({
  object: z.literal("stats"),
  attributes: z.object({
    current_state: z.string().min(1).max(40),
    is_suspended: z.boolean(),
  }),
});
export type PterodactylResources = z.infer<typeof pterodactylResources>;

export class PterodactylClient {
  readonly http: ProviderHttp;
  constructor(base: string, token: string) {
    this.http = new ProviderHttp(
      "pterodactyl",
      base,
      { Authorization: token ? `Bearer ${token}` : "" },
      10000,
    );
  }
  isConfigured() {
    return !!this.http.headers.Authorization;
  }
  async servers() {
    const result: z.infer<typeof server>["attributes"][] = [];
    for (let page = 1; page <= 20; page++) {
      const response = await this.http.request(
        "GET",
        `/api/client?page=${page}`,
        serverList,
      );
      result.push(...response.data.map((item) => item.attributes));
      if (page >= response.meta.pagination.total_pages) return result;
    }
    throw new ProviderError("contract-mismatch", "pterodactyl");
  }
  resources(identifier: string): Promise<PterodactylResources> {
    return this.http.request(
      "GET",
      `/api/client/servers/${pathId(identifier)}/resources`,
      pterodactylResources,
    );
  }
}

export function summarizePterodactylHealth(snapshot: PterodactylResources) {
  const powerState = snapshot.attributes.current_state.toLowerCase();
  const suspended = snapshot.attributes.is_suspended;
  const state = suspended
    ? "down"
    : powerState === "running"
      ? "healthy"
      : ["starting", "stopping"].includes(powerState)
        ? "degraded"
        : powerState === "offline"
          ? "down"
          : "unknown";
  return { state, detail: { powerState, suspended } } as const;
}
