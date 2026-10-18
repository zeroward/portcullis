import Fastify from "fastify";
import { z } from "zod";
export async function providerFixture(port = 4200) {
  const app = Fastify();
  const state = {
    widenPolicyReadback: false,
    pocketUsers: [
      {
        id: "pid-member",
        username: "alex",
        displayName: "Alex",
        firstName: "Alex",
        lastName: "",
        email: "alex@example.invalid",
        isAdmin: false,
        disabled: false,
        userGroups: [] as any[],
      },
    ],
    pocketGroup: {
      id: "pid-gaming",
      name: "gaming",
      friendlyName: "Gaming",
      users: [
        {
          id: "unmanaged-user",
          username: "existing",
          displayName: "Existing member",
          isAdmin: false,
          disabled: false,
          userGroups: [],
        },
      ] as any[],
    },
    users: [
      {
        id: "nb-member",
        name: "Alex",
        email: "alex@example.invalid",
        role: "admin",
        auto_groups: ["unmanaged"],
        is_blocked: false,
      },
    ],
    peers: [
      {
        id: "peer-existing",
        name: "Desktop",
        ip: "100.90.0.2",
        user_id: "nb-member",
        os: "windows",
        connected: true,
        last_seen: new Date().toISOString(),
      },
    ] as any[],
    groups: [
      {
        id: "nb-gaming",
        name: "Gaming access",
        issued: "api",
        peers: [{ id: "unmanaged-peer" }],
        resources: [{ id: "resource-1", type: "host" }],
      },
      {
        id: "nb-server",
        name: "Realm server",
        issued: "api",
        peers: [{ id: "realm-peer" }],
        resources: [],
      },
      { id: "all", name: "All", issued: "api", peers: [], resources: [] },
    ],
    resources: [
      {
        id: "resource-1",
        name: "Existing resource",
        address: "192.168.10.5",
        groups: ["nb-server"],
        enabled: true,
      },
    ] as any[],
    routers: [
      {
        id: "router-1",
        peer: "realm-peer",
        metric: 100,
        masquerade: true,
        enabled: true,
      },
    ] as any[],
    policies: [
      {
        id: "default",
        name: "Default",
        enabled: true,
        rules: [
          {
            enabled: true,
            action: "accept",
            protocol: "all",
            bidirectional: true,
            sources: [{ id: "all" }],
            destinations: [{ id: "all" }],
          },
        ],
      },
    ] as any[],
    setupKeys: [
      {
        id: "key-1",
        key: "never-expose-from-list",
        auto_groups: ["nb-gaming"],
        revoked: false,
      },
    ],
    writes: [] as any[],
    failWrites: false,
    ambiguous: false,
    delayMs: 0,
  };
  app.addHook("onRequest", async (r, reply) => {
    const pocket = r.url.includes("user-groups") || r.headers["x-api-key"];
    if (
      pocket
        ? r.headers["x-api-key"] !== "pocket-fixture-key"
        : r.headers.authorization !== "Token netbird-fixture-token"
    )
      return reply.code(401).send({ error: "unauthorized" });
  });
  app.get("/api/users", (r) =>
    r.headers["x-api-key"]
      ? {
          data: state.pocketUsers,
          pagination: { totalPages: 1, totalItems: 1 },
        }
      : state.users,
  );
  app.get(
    "/api/users/:id",
    (r) =>
      state.pocketUsers.find((u) => u.id === (r.params as any).id) ??
      state.pocketUsers[0],
  );
  app.get("/api/user-groups", () => ({
    data: [state.pocketGroup],
    pagination: { totalPages: 1 },
  }));
  app.get("/api/user-groups/:id", () => state.pocketGroup);
  app.put("/api/user-groups/:id/users", async (r, reply) => {
    const b = z
      .object({ userIds: z.array(z.string()) })
      .strict()
      .parse(r.body);
    state.writes.push({ path: r.url, body: b });
    if (state.delayMs)
      await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    if (state.failWrites) return reply.code(503).send({ error: "failed" });
    state.pocketGroup.users = b.userIds.map(
      (id) =>
        state.pocketGroup.users.find((u) => u.id === id) ??
        state.pocketUsers.find((u) => u.id === id)!,
    );
    if (state.ambiguous) {
      state.ambiguous = false;
      return reply.code(504).send({ error: "response_lost" });
    }
    return state.pocketGroup;
  });
  app.post("/api/users", (r) => {
    const b = r.body as any;
    return { id: "new-user", ...b, userGroups: [] };
  });
  app.post("/api/user-groups", (r) => ({
    id: "new-group",
    ...(r.body as any),
  }));
  app.post("/api/users/:id/one-time-access-token", () => ({
    token: "sensitive-enrollment-token",
  }));
  app.get("/api/groups", () => state.groups);
  app.get(
    "/api/groups/:id",
    (r, reply) =>
      state.groups.find((g) => g.id === (r.params as any).id) ??
      reply.code(404).send({ error: "not_found" }),
  );
  app.put("/api/groups/:id", async (r, reply) => {
    const b = z
      .object({
        name: z.string(),
        peers: z.array(z.string()),
        resources: z.array(z.object({ id: z.string(), type: z.string() })),
      })
      .strict()
      .parse(r.body);
    state.writes.push({ path: r.url, body: b });
    if (state.delayMs)
      await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    if (state.failWrites) return reply.code(503).send({ error: "failed" });
    const group = state.groups.find((g) => g.id === (r.params as any).id)!;
    Object.assign(group, {
      name: b.name,
      peers: b.peers.map((id) => ({ id })),
      resources: b.resources,
    });
    return group;
  });
  app.put("/api/users/:id", async (r, reply) => {
    const b = z
      .object({
        role: z.string(),
        is_blocked: z.boolean(),
        auto_groups: z.array(z.string()),
      })
      .strict()
      .parse(r.body);
    state.writes.push({ path: r.url, body: b });
    if (state.delayMs)
      await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    if (state.failWrites) return reply.code(503).send({ error: "failed" });
    const user = state.users.find((u) => u.id === (r.params as any).id)!;
    Object.assign(user, b);
    if (state.ambiguous) {
      state.ambiguous = false;
      return reply.code(504).send({ error: "response_lost" });
    }
    return user;
  });
  app.get("/api/peers", () => state.peers);
  app.delete("/api/peers/:id", (r, reply) => {
    state.peers = state.peers.filter((p) => p.id !== (r.params as any).id);
    return reply.code(204).send();
  });
  app.get("/api/policies", () => state.policies);
  app.post("/api/policies", (r) => {
    const policy = { id: "managed-policy", ...(r.body as any) };
    state.policies.push(policy);
    return policy;
  });
  app.get("/api/policies/:id", (r) => {
    const policy = state.policies.find((p) => p.id === (r.params as any).id);
    return state.widenPolicyReadback
      ? {
          ...policy,
          rules: policy.rules.map((rule: any) => ({
            ...rule,
            sources: [{ id: "all" }],
          })),
        }
      : policy;
  });
  app.get("/api/setup-keys", () => state.setupKeys);
  app.get("/api/setup-keys/:id", () => state.setupKeys[0]);
  app.put("/api/setup-keys/:id", (r) => {
    Object.assign(state.setupKeys[0], r.body);
    return state.setupKeys[0];
  });
  app.post("/api/setup-keys", (r) => ({
    id: "created-key",
    key: "reveal-once",
    ...(r.body as any),
  }));
  app.get("/api/networks", () => [{ id: "network-1", name: "Gaming network" }]);
  app.get("/api/networks/:id/resources", () => state.resources);
  app.get("/api/networks/:id/routers", () => state.routers);
  app.get("/api/networks/:id/resources/:resourceId", (r) =>
    state.resources.find((x) => x.id === (r.params as any).resourceId),
  );
  app.post("/api/networks/:id/resources", (r) => {
    const x = { id: "resource-created", ...(r.body as any) };
    state.resources.push(x);
    return x;
  });
  app.get("/api/networks/:id/routers/:routerId", (r) =>
    state.routers.find((x) => x.id === (r.params as any).routerId),
  );
  app.post("/api/networks/:id/routers", (r) => {
    const x = { id: "router-created", ...(r.body as any) };
    state.routers.push(x);
    return x;
  });
  app.get("/api/accounts", () => [{ id: "account-1" }]);
  app.get("/api/events", () => []);
  app.get("/api/dns/settings", () => ({ disabled_management_groups: [] }));
  app.get("/api/dns/nameservers", () => []);
  await app.listen({ port, host: "127.0.0.1" });
  return { app, state, url: `http://127.0.0.1:${port}` };
}
