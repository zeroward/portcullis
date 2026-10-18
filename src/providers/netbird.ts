import { z } from "zod";
import type { Database, Queryable } from "../db/index.js";
import { ProviderHttp, pathId, writeResult, ProviderError } from "./http.js";
const idObject = z.object({ id: z.string() }).passthrough();
export const nbUser = z
  .object({
    id: z.string(),
    name: z.string(),
    email: z.string().optional(),
    role: z.string(),
    auto_groups: z.array(z.string()),
    is_blocked: z.boolean(),
  })
  .passthrough();
export const nbPeer = z
  .object({
    id: z.string(),
    name: z.string(),
    user_id: z.string().optional(),
    ip: z.string(),
    connected: z.boolean().optional(),
    last_seen: z.string().optional(),
    os: z.string().optional(),
    groups: z.array(idObject).optional(),
  })
  .passthrough();
export const nbGroup = z
  .object({
    id: z.string(),
    name: z.string(),
    issued: z.string().optional(),
    // NetBird serializes empty Go slices as null, including on populated groups.
    peers: z
      .array(idObject)
      .nullish()
      .transform((value) => value ?? []),
    resources: z
      .array(z.object({ id: z.string(), type: z.string() }).passthrough())
      .nullish()
      .transform((value) => value ?? []),
  })
  .passthrough();
export const narrowPolicy = z
  .object({
    name: z.string().min(2).max(100),
    sourceGroup: z.string().min(1),
    destinationGroup: z.string().min(1),
    protocol: z.enum(["tcp", "udp"]),
    ports: z.array(z.number().int().min(1).max(65535)).min(1).max(16),
  })
  .strict()
  .refine(
    (d) => d.sourceGroup !== d.destinationGroup,
    "Source and destination must differ",
  );
export class NetBirdClient {
  readonly http: ProviderHttp;
  constructor(
    base: string,
    token: string,
    readonly capabilities: Record<string, boolean> = {},
  ) {
    this.http = new ProviderHttp("netbird", base, {
      Authorization: token ? `Token ${token}` : "",
    });
  }
  users() {
    return this.http.request("GET", "/api/users", z.array(nbUser));
  }
  peers() {
    return this.http.request("GET", "/api/peers", z.array(nbPeer));
  }
  groups() {
    return this.http.request("GET", "/api/groups", z.array(nbGroup));
  }
  group(id: string) {
    return this.http.request("GET", `/api/groups/${pathId(id)}`, nbGroup);
  }
  policies() {
    return this.http.request("GET", "/api/policies", z.array(idObject));
  }
  accounts() {
    return this.http.request("GET", "/api/accounts", z.array(idObject));
  }
  events() {
    return this.http.request(
      "GET",
      "/api/events",
      z.array(z.object({ activity: z.string().optional() }).passthrough()),
    );
  }
  dns() {
    return Promise.all([
      this.http.request(
        "GET",
        "/api/dns/settings",
        z
          .object({ disabled_management_groups: z.array(z.string()) })
          .passthrough(),
      ),
      this.http.request("GET", "/api/dns/nameservers", z.array(idObject)),
    ]);
  }
  networks() {
    if (this.capabilities["netbird.networks"] !== true)
      throw new ProviderError("unsupported", "netbird");
    return this.http.request("GET", "/api/networks", z.array(idObject));
  }
  resources(network: string) {
    return this.http.request(
      "GET",
      `/api/networks/${pathId(network)}/resources`,
      z.array(idObject),
    );
  }
  routers(network: string) {
    return this.http.request(
      "GET",
      `/api/networks/${pathId(network)}/routers`,
      z.array(idObject),
    );
  }
  async setupKeys() {
    const keys = await this.http.request(
      "GET",
      "/api/setup-keys",
      z.array(idObject),
    );
    return keys.map(({ key: _key, ...metadata }) => metadata);
  }
  async diagnostics() {
    const [users, peers, groups] = await Promise.all([
      this.users(),
      this.peers(),
      this.groups(),
    ]);
    return {
      provider: "netbird",
      reachable: true,
      users: users.length,
      peers: peers.length,
      groups: groups.length,
      verification: "control-plane-only",
    };
  }
  async updateGroup(before: z.infer<typeof nbGroup>, ids: string[]) {
    if (before.issued && before.issued !== "api")
      throw new ProviderError("conflict", "netbird");
    await this.http.request(
      "PUT",
      `/api/groups/${pathId(before.id)}`,
      nbGroup,
      {
        name: before.name,
        peers: [...new Set(ids)],
        resources: before.resources,
      },
    );
    const after = await this.group(before.id);
    if (ids.some((id) => !after.peers.some((p) => p.id === id)))
      throw new ProviderError("conflict", "netbird", true);
    return after;
  }
  async access(
    db: Queryable,
    database: Database,
    userId: string,
    groupId: string,
    present: boolean,
  ) {
    return database.withLock(`netbird-group:${groupId}`, async () => {
      const users = await this.users();
      const user = users.find((u) => u.id === userId);
      if (!user) throw new ProviderError("not-found", "netbird");
      let group = await this.group(groupId);
      if (group.issued && group.issued !== "api")
        throw new ProviderError("conflict", "netbird");
      const owned = (await this.peers()).filter((p) => p.user_id === userId);
      let [userEdge] = await db.query(
        "SELECT * FROM managed_edges WHERE provider='netbird-user' AND resource_id=$1 AND subject_id=$2",
        [groupId, userId],
      );
      if (present) {
        // Reserve durable edge ownership before writes; survives ambiguous responses and worker crashes.
        for (const peer of owned) {
          const had = group.peers.some((p) => p.id === peer.id);
          await db.query(
            "INSERT INTO managed_edges(provider,resource_id,subject_id,added) VALUES ('netbird-peer',$1,$2,$3) ON CONFLICT DO NOTHING",
            [groupId, peer.id, !had || !!userEdge?.added],
          );
        }
        if (!userEdge) {
          await db.query(
            "INSERT INTO managed_edges(provider,resource_id,subject_id,added) VALUES ('netbird-user',$1,$2,$3) ON CONFLICT DO NOTHING",
            [groupId, userId, !user.auto_groups.includes(groupId)],
          );
          [userEdge] = await db.query(
            "SELECT * FROM managed_edges WHERE provider='netbird-user' AND resource_id=$1 AND subject_id=$2",
            [groupId, userId],
          );
        }
      }
      const auto = present
        ? [...new Set([...user.auto_groups, groupId])]
        : userEdge?.added
          ? user.auto_groups.filter((g) => g !== groupId)
          : user.auto_groups;
      if (JSON.stringify(auto) !== JSON.stringify(user.auto_groups))
        await this.http.request("PUT", `/api/users/${pathId(userId)}`, nbUser, {
          role: user.role,
          is_blocked: user.is_blocked,
          auto_groups: auto,
        });
      if (!present && userEdge?.added) {
        // Include peers enrolled after the initial grant, but never reinterpret setup-key revocation as peer removal.
        for (const peer of owned)
          await db.query(
            "INSERT INTO managed_edges(provider,resource_id,subject_id,added) VALUES ('netbird-peer',$1,$2,true) ON CONFLICT DO NOTHING",
            [groupId, peer.id],
          );
      }
      group = await this.group(groupId);
      const removable = (
        await db.query(
          "SELECT subject_id FROM managed_edges WHERE provider='netbird-peer' AND resource_id=$1 AND added",
          [groupId],
        )
      )
        .map((r) => r.subject_id)
        .filter((id) => owned.some((p) => p.id === id));
      const ids = present
        ? [
            ...new Set([
              ...group.peers.map((p) => p.id),
              ...owned.map((p) => p.id),
            ]),
          ]
        : group.peers.map((p) => p.id).filter((id) => !removable.includes(id));
      const changed =
        JSON.stringify(auto) !== JSON.stringify(user.auto_groups) ||
        JSON.stringify(ids) !== JSON.stringify(group.peers.map((p) => p.id));
      if (JSON.stringify(ids) !== JSON.stringify(group.peers.map((p) => p.id)))
        await this.updateGroup(group, ids);
      const after = (await this.users()).find((u) => u.id === userId);
      const afterGroup = await this.group(groupId);
      if (
        !after ||
        after.role !== user.role ||
        after.is_blocked !== user.is_blocked ||
        JSON.stringify(after.auto_groups) !== JSON.stringify(auto) ||
        ids.some((id) => !afterGroup.peers.some((p) => p.id === id)) ||
        (!present &&
          removable.some((id) => afterGroup.peers.some((p) => p.id === id)))
      )
        throw new ProviderError("conflict", "netbird", true);
      if (!present) {
        await db.query(
          "DELETE FROM managed_edges WHERE resource_id=$1 AND ((provider='netbird-user' AND subject_id=$2) OR (provider='netbird-peer' AND subject_id=ANY($3::text[])))",
          [groupId, userId, owned.map((p) => p.id)],
        );
      }
      const unmanagedMembershipRetained =
        !present &&
        (after.auto_groups.includes(groupId) ||
          owned.some((p) => afterGroup.peers.some((g) => g.id === p.id)));
      return {
        controlPlaneVerified: true,
        trafficVerified: false,
        changed,
        desiredPresent: present,
        unmanagedMembershipRetained,
      };
    });
  }
  createGroup(name: string) {
    return this.http.request("POST", "/api/groups", nbGroup, {
      name: z.string().min(2).max(100).parse(name),
      peers: [],
      resources: [],
    });
  }
  async createPolicy(input: unknown) {
    const d = narrowPolicy.parse(input);
    const groups = await this.groups();
    const source = groups.find((g) => g.id === d.sourceGroup);
    const destination = groups.find((g) => g.id === d.destinationGroup);
    if (
      !source ||
      !destination ||
      [source, destination].some((g) => g.name === "All")
    )
      throw new ProviderError("forbidden", "netbird");
    const created = await this.http.request("POST", "/api/policies", idObject, {
      name: d.name,
      description: "Portcullis managed narrow service access",
      enabled: true,
      rules: [
        {
          name: d.name,
          description: "Approved service ports",
          enabled: true,
          action: "accept",
          bidirectional: false,
          protocol: d.protocol,
          ports: d.ports.map(String),
          sources: [d.sourceGroup],
          destinations: [d.destinationGroup],
        },
      ],
    });
    const after = await this.http.request(
      "GET",
      `/api/policies/${pathId(created.id)}`,
      idObject,
    );
    const rule = (after.rules as any[])?.[0];
    const matchesGroup = (values: unknown, expected: string) =>
      Array.isArray(values) &&
      values.length === 1 &&
      (typeof values[0] === "string" ? values[0] : values[0]?.id) === expected;
    if (
      !rule ||
      after.enabled !== true ||
      (after.rules as any[]).length !== 1 ||
      rule.enabled !== true ||
      rule.action !== "accept" ||
      !matchesGroup(rule.sources, d.sourceGroup) ||
      !matchesGroup(rule.destinations, d.destinationGroup) ||
      rule.protocol !== d.protocol ||
      rule.bidirectional !== false ||
      JSON.stringify(rule.ports) !== JSON.stringify(d.ports.map(String))
    )
      throw new ProviderError("conflict", "netbird", true);
    return { ...after, controlPlaneVerified: true, trafficVerified: false };
  }
  async broadPolicyWarnings() {
    const [policies, groups] = await Promise.all([
      this.policies(),
      this.groups(),
    ]);
    const all = groups.filter((g) => g.name === "All").map((g) => g.id);
    return policies
      .filter((p) =>
        ((p.rules as any[]) ?? []).some(
          (r) =>
            r.enabled &&
            r.action === "accept" &&
            (r.protocol === "all" ||
              r.bidirectional ||
              (r.sources ?? []).some((g: any) =>
                all.includes(typeof g === "string" ? g : g.id),
              )),
        ),
      )
      .map((p) => ({
        id: p.id,
        warning:
          "Broad existing policy may independently permit access; it has not been changed.",
      }));
  }
  async createResource(network: string, input: unknown) {
    if (!this.capabilities["netbird.networks"])
      throw new ProviderError("unsupported", "netbird");
    const d = z
      .object({
        name: z.string().min(2),
        description: z.string().default(""),
        address: z.string().min(1),
        groups: z.array(z.string()).min(1),
        enabled: z.boolean().default(true),
      })
      .strict()
      .parse(input);
    if (
      !/^[a-zA-Z0-9.:[\]-]+$/.test(d.address) ||
      /^(0\.0\.0\.0|::)$/.test(d.address)
    )
      throw new ProviderError("forbidden", "netbird");
    const created = await this.http.request(
      "POST",
      `/api/networks/${pathId(network)}/resources`,
      idObject,
      d,
    );
    const after = await this.http.request(
      "GET",
      `/api/networks/${pathId(network)}/resources/${pathId(created.id)}`,
      idObject,
    );
    if (after.address !== d.address)
      throw new ProviderError("conflict", "netbird", true);
    return after;
  }
  async createRouter(network: string, input: unknown) {
    if (!this.capabilities["netbird.networks"])
      throw new ProviderError("unsupported", "netbird");
    const d = z
      .object({
        peer: z.string().min(1),
        metric: z.number().int().min(1).max(9999).default(100),
        masquerade: z.boolean().default(true),
        enabled: z.boolean().default(true),
      })
      .strict()
      .parse(input);
    const created = await this.http.request(
      "POST",
      `/api/networks/${pathId(network)}/routers`,
      idObject,
      d,
    );
    const after = await this.http.request(
      "GET",
      `/api/networks/${pathId(network)}/routers/${pathId(created.id)}`,
      idObject,
    );
    if (after.peer !== d.peer || after.enabled !== d.enabled)
      throw new ProviderError("conflict", "netbird", true);
    return after;
  }
  createSetupKey(name: string, groups: string[]) {
    return this.http.request(
      "POST",
      "/api/setup-keys",
      idObject.extend({ key: z.string() }),
      {
        name,
        type: "one-off",
        expires_in: 86400,
        auto_groups: groups,
        usage_limit: 1,
        ephemeral: false,
      },
    );
  }
  async revokeSetupKey(id: string) {
    const schema = idObject.extend({
      auto_groups: z.array(z.string()),
      revoked: z.boolean(),
    });
    const key = await this.http.request(
      "GET",
      `/api/setup-keys/${pathId(id)}`,
      schema,
    );
    await this.http.request("PUT", `/api/setup-keys/${pathId(id)}`, idObject, {
      revoked: true,
      auto_groups: key.auto_groups,
    });
    const after = await this.http.request(
      "GET",
      `/api/setup-keys/${pathId(id)}`,
      schema,
    );
    if (!after.revoked) throw new ProviderError("conflict", "netbird", true);
    return { id, revoked: true, peersRemoved: false };
  }
  removePeer(id: string) {
    return this.http.request("DELETE", `/api/peers/${pathId(id)}`, writeResult);
  }
}
