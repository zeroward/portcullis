import { z } from "zod";
import { ProviderHttp, pathId, writeResult, ProviderError } from "./http.js";
export const pocketGroup = z
  .object({ id: z.string(), name: z.string(), friendlyName: z.string() })
  .passthrough();
export const pocketUser = z
  .object({
    id: z.string(),
    username: z.string(),
    displayName: z.string(),
    email: z.string().nullable().optional(),
    isAdmin: z.boolean(),
    disabled: z.boolean().default(false),
    userGroups: z.array(pocketGroup).default([]),
  })
  .passthrough();
export class PocketIdClient {
  readonly http: ProviderHttp;
  constructor(
    base: string,
    key: string,
    readonly capabilities: Record<string, boolean> = {},
  ) {
    this.http = new ProviderHttp("pocket-id", base, { "X-API-KEY": key });
  }
  user(id: string) {
    return this.http.request("GET", `/api/users/${pathId(id)}`, pocketUser);
  }
  group(id: string) {
    return this.http.request(
      "GET",
      `/api/user-groups/${pathId(id)}`,
      pocketGroup.extend({ users: z.array(pocketUser) }),
    );
  }
  async list<T>(path: string, schema: z.ZodType<T>) {
    const all: T[] = [];
    for (let page = 1; page <= 100; page++) {
      const r = await this.http.request(
        "GET",
        `${path}?pagination[page]=${page}&pagination[limit]=100`,
        z.object({
          data: z.array(schema),
          pagination: z
            .object({ totalPages: z.number().optional() })
            .passthrough(),
        }),
      );
      all.push(...r.data);
      if (
        r.data.length < 100 ||
        (r.pagination.totalPages !== undefined &&
          page >= r.pagination.totalPages)
      )
        return all;
    }
    throw new ProviderError("contract-mismatch", "pocket-id");
  }
  users() {
    return this.list("/api/users", pocketUser);
  }
  groups() {
    return this.list("/api/user-groups", pocketGroup);
  }
  async setMembership(group: string, user: string, present: boolean) {
    const before = await this.group(group);
    if (before.ldapId) throw new ProviderError("conflict", "pocket-id");
    const ids = before.users.map((u) => u.id);
    const next = present
      ? [...new Set([...ids, user])]
      : ids.filter((id) => id !== user);
    if (JSON.stringify(next) !== JSON.stringify(ids))
      await this.http.request(
        "PUT",
        `/api/user-groups/${pathId(group)}/users`,
        writeResult,
        { userIds: next },
      );
    const after = await this.group(group);
    if (
      after.users.some((u) => u.id === user) !== present ||
      ids
        .filter((id) => id !== user)
        .some((id) => !after.users.some((u) => u.id === id))
    )
      throw new ProviderError("conflict", "pocket-id", true);
    return { verified: true, previouslyPresent: ids.includes(user) };
  }
  createGroup(name: string, friendlyName: string) {
    return this.http.request(
      "POST",
      "/api/user-groups",
      pocketGroup,
      z
        .object({
          name: z.string().min(2).max(255),
          friendlyName: z.string().min(2).max(50),
        })
        .parse({ name, friendlyName }),
    );
  }
  createUser(input: unknown) {
    const body = z
      .object({
        username: z.string().min(1).max(50),
        firstName: z.string().max(50).default(""),
        lastName: z.string().max(50).default(""),
        displayName: z.string().max(100),
        email: z.email().optional(),
      })
      .strict()
      .parse(input);
    return this.http.request("POST", "/api/users", pocketUser, {
      ...body,
      isAdmin: false,
      emailVerified: false,
      disabled: false,
      userGroupIds: [],
    });
  }
  async diagnostics() {
    const [users, groups] = await Promise.all([this.users(), this.groups()]);
    return {
      provider: "pocket-id",
      reachable: true,
      users: users.length,
      groups: groups.length,
      verification: "control-plane-only",
    };
  }
  async enrollment(user: string) {
    if (!this.capabilities["pocket.enrollment"])
      return {
        state: "unsupported",
        handoff: `${this.http.base}/settings/admin/users/${pathId(user)}`,
        reason:
          "Enable enrollment only after verifying the configured Pocket ID API version.",
      };
    return this.http.request(
      "POST",
      `/api/users/${pathId(user)}/one-time-access-token`,
      z.object({ token: z.string() }),
      {},
    );
  }
}
