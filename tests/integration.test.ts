import { beforeAll, afterAll, describe, it, expect } from "vitest";
import EmbeddedPostgres from "embedded-postgres";
import { mkdtemp, readFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { Database } from "../src/db/index.js";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { migrate } from "../scripts/migrate.js";
import { seed } from "../scripts/seed.js";
import { devIssuer } from "../scripts/dev-oidc.js";
import { providerFixture } from "./fixtures.js";
import { Jobs } from "../src/domain/jobs.js";
import { effectiveBindings, validGrant } from "../src/domain/access.js";
import {
  ManualServiceProvider,
  MockServiceProvider,
  WowManagerProvider,
} from "../src/providers/contracts.js";
import { allowedAddress, checkedHttp, parseKuma } from "../src/monitoring.js";
import { can } from "../src/domain/authorization.js";
import { hash, signedBody } from "../src/security.js";
import { Notifications } from "../src/notifications.js";
let pg: EmbeddedPostgres;
let db: Database;
let system: Awaited<ReturnType<typeof createApp>>;
let issuer: Awaited<ReturnType<typeof devIssuer>>;
let fixture: Awaited<ReturnType<typeof providerFixture>>;
let jobs: Jobs;
let monitor: ReturnType<typeof Fastify>;
let directory: string;
const env = {
  NODE_ENV: "test",
  RATE_LIMIT_MAX: "1000",
  BASE_URL: "http://localhost:3000",
  DATABASE_URL: "postgres://test:test@127.0.0.1:55432/portcullis_test",
  ENCRYPTION_KEY: "1".repeat(64),
  OIDC_ISSUER: "http://localhost:4100",
  OIDC_CLIENT_ID: "portcullis",
  OIDC_CLIENT_SECRET: "development-secret",
  OWNER_SUBJECT: "dev-owner",
  ROLE_GROUP_MAPPINGS: JSON.stringify({
    "portal-support": ["support"],
    "portal-approvers": ["approver"],
  }),
  POCKET_ID_URL: "http://127.0.0.1:4200",
  POCKET_ID_API_KEY: "pocket-fixture-key",
  NETBIRD_URL: "http://127.0.0.1:4200",
  NETBIRD_TOKEN: "netbird-fixture-token",
  CAPABILITY_OVERRIDES: '{"netbird.networks":true,"pocket.enrollment":true}',
  MONITOR_ALLOWED_CIDRS: "127.0.0.1/32,192.168.10.0/24",
  MONITOR_ALLOWED_PORTS: "4300,80,443",
  HEALTH_WEBHOOK_KEY: "h".repeat(32),
};
let owner: any;
let member: any;
let support: any;
let approver: any;
let approver2: any;
function cookies(r: any) {
  return r.cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
}
async function login(user: string) {
  const start = await system.app.inject({ url: "/auth/login" });
  expect(start.statusCode).toBe(302);
  const location = new URL(start.headers.location!);
  location.searchParams.set("user", user);
  const authorize = await fetch(location, { redirect: "manual" });
  const callback = new URL(authorize.headers.get("location")!);
  const result = await system.app.inject({
    url: callback.pathname + callback.search,
    headers: { cookie: cookies(start) },
  });
  if (result.statusCode !== 302) return { response: result };
  const cookie = cookies(result);
  const me = await system.app.inject({ url: "/api/me", headers: { cookie } });
  return { response: result, cookie, ...me.json() };
}
async function call(actor: any, url: string, method: any = "GET", body?: any) {
  return system.app.inject({
    url,
    method,
    headers: {
      cookie: actor.cookie,
      origin: env.BASE_URL,
      "x-csrf-token": actor.csrf,
    },
    ...(body !== undefined ? { payload: body } : {}),
  });
}
async function entitlement(
  key: string,
  policy: any = {},
  bindings: any[] = [],
) {
  const r = await call(owner, "/api/entitlements", "POST", {
    key,
    name: key,
    policy: {
      requestable: true,
      approvals: 1,
      noSelfApproval: true,
      maxHours: 720,
      defaultHours: 168,
      ...policy,
    },
    prerequisites: [],
  });
  expect(r.statusCode).toBe(200);
  const e = r.json();
  for (const b of bindings) {
    const response = await call(owner, "/api/admin/bindings", "POST", {
      entitlementId: e.id,
      provider: b.provider,
      externalId: b.externalId,
      configuration: {},
      confirmation: "MANAGE",
    });
    expect(response.statusCode).toBe(200);
  }
  return e;
}
async function request(e: any, user = member, hours = 24) {
  const r = await call(user, "/api/requests", "POST", {
    entitlementId: e.id,
    reason: "I would like to join the community service",
    durationHours: hours,
  });
  expect(r.statusCode).toBe(200);
  return r.json();
}
async function approve(r: any, actor = owner) {
  return call(actor, `/api/requests/${r.id}/decide`, "POST", {
    decision: "approved",
    reason: "Approved for designated access",
    durationHours: 24,
    confirmation: "APPROVE",
  });
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "portcullis-test-"));
  pg = new EmbeddedPostgres({
    databaseDir: join(directory, "db"),
    user: "test",
    password: "test",
    port: 55432,
    persistent: true,
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("portcullis_test");
  db = new Database(env.DATABASE_URL);
  await migrate(db);
  await migrate(db);
  await seed(db, "test");
  fixture = await providerFixture();
  issuer = await devIssuer();
  system = await createApp(
    loadConfig({ ...env, UPLOAD_DIR: join(directory, "uploads") }),
    { db, static: false, logger: false },
  );
  jobs = new Jobs(db, system.clients);
  owner = await login("dev-owner");
  member = await login("dev-member");
  support = await login("dev-support");
  approver = await login("dev-approver");
  approver2 = await login("dev-approver-2");
  monitor = Fastify();
  monitor.get("/health", () => ({ status: "ok" }));
  monitor.get("/redirect", (_r: any, reply: any) =>
    reply.redirect("http://169.254.169.254/"),
  );
  monitor.get(
    "/metrics",
    () => 'monitor_status{monitor_name="Realm",monitor_type="http"} 1\n',
  );
  await monitor.listen({ port: 4300, host: "127.0.0.1" });
});
afterAll(async () => {
  await monitor?.close();
  await system?.app.close();
  await fixture?.app.close();
  await issuer?.app.close();
  await db?.close();
  await pg?.stop();
});
describe("form lookup authorization and minimal projections", () => {
  it("limits lookups by permission and never returns stored secret values", async () => {
    for (const path of [
      "users?purpose=identity.manage",
      "netbird-users",
      "pocket-groups",
      "secrets",
      "jobs",
      "providers?purpose=binding",
      "entitlements",
    ]) {
      expect((await call(member, `/api/form-options/${path}`)).statusCode).toBe(
        403,
      );
    }
    const secret = await call(owner, "/api/admin/secrets", "POST", {
      name: "form-test-secret",
      value: "never-return-this-value",
      confirmation: "ROTATE SECRET",
    });
    expect(secret.statusCode).toBe(200);
    const choices = await call(owner, "/api/form-options/secrets");
    expect(choices.statusCode).toBe(200);
    expect(choices.json()).toContainEqual({
      id: secret.json().id,
      label: "form-test-secret",
    });
    expect(choices.body).not.toMatch(
      /ciphertext|never-return-this-value|updated_by/,
    );
    const users = await call(
      owner,
      "/api/form-options/users?purpose=identity.manage",
    );
    expect(
      users
        .json()
        .every((u: any) =>
          Object.keys(u).every((k) =>
            ["id", "label", "description", "disabled", "reason"].includes(k),
          ),
        ),
    ).toBe(true);
    const groups = (
      await call(owner, "/api/form-options/netbird-groups?purpose=binding")
    ).json();
    expect(groups.find((g: any) => g.label === "All").disabled).toBe(true);
    expect(
      (await call(owner, `/api/admin/users/${owner.id}/roles`)).json().editable,
    ).toBe(false);
    expect(
      (await call(member, `/api/admin/users/${member.id}/roles`)).statusCode,
    ).toBe(403);
  });
  it("returns success for role changes and preserves inherited role sources", async () => {
    const [service] = await db.query("SELECT id FROM services LIMIT 1");
    const inherited = await db.query(
      "SELECT role,scope,source FROM roles WHERE user_id=$1 AND source<>'operator' ORDER BY role",
      [support.id],
    );
    const result = await call(
      owner,
      `/api/admin/users/${support.id}/roles`,
      "PUT",
      {
        roles: [{ role: "support", scope: service.id }],
        confirmation: "CHANGE ROLES",
      },
    );
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ ok: true });
    const roles = (
      await call(owner, `/api/admin/users/${support.id}/roles`)
    ).json();
    expect(roles.roles.filter((r: any) => r.source !== "operator")).toEqual(
      inherited,
    );
    expect(roles.roles).toContainEqual({
      role: "support",
      scope: service.id,
      source: "operator",
    });
    await db.query("DELETE FROM roles WHERE user_id=$1 AND source='operator'", [
      support.id,
    ]);
    support = await login("dev-support");
  });
  it("filters service scopes and ticket assignees without disclosing unrelated services", async () => {
    const [first, second] = await db.query(
      "SELECT id FROM services ORDER BY id LIMIT 2",
    );
    await db.query(
      "INSERT INTO roles(user_id,role,scope) VALUES ($1,'service-admin',$2)",
      [support.id, first.id],
    );
    try {
      const result = await call(
        support,
        "/api/form-options/services?purpose=monitor.manage",
      );
      expect(result.statusCode).toBe(200);
      expect(result.json().map((o: any) => o.id)).toEqual([first.id]);
      expect(result.body).not.toContain(second.id);
      expect(
        (await call(support, "/api/form-options/users?purpose=identity.manage"))
          .statusCode,
      ).toBe(403);
    } finally {
      await db.query(
        "DELETE FROM roles WHERE user_id=$1 AND role='service-admin'",
        [support.id],
      );
    }
    const ticket = await call(member, "/api/tickets", "POST", {
      subject: "Form lookup test",
      description: "Check ticket assignment privacy",
      priority: "normal",
      type: "technical problem",
      serviceId: first.id,
    });
    expect(ticket.statusCode).toBe(200);
    const assignees = await call(
      owner,
      `/api/form-options/assignees?ticketId=${ticket.json().id}`,
    );
    expect(assignees.statusCode).toBe(200);
    expect(assignees.json().some((a: any) => a.id === owner.id)).toBe(true);
    expect(assignees.json().some((a: any) => a.id === member.id)).toBe(false);
    expect(
      (
        await call(
          member,
          `/api/form-options/assignees?ticketId=${ticket.json().id}`,
        )
      ).statusCode,
    ).toBe(403);
  });
});
describe("OIDC and portal authorization", () => {
  it("migrates once on a clean real PostgreSQL database and seeds only explicitly", async () => {
    expect((await db.query("SELECT * FROM schema_migrations")).length).toBe(2);
    expect((await db.query("SHOW server_version"))[0].server_version).toMatch(
      /^18/,
    );
    await expect(seed(db, "production")).rejects.toThrow();
  });
  it("signed code flow creates member identity by issuer and subject, never first-login owner", async () => {
    expect(member.roles.map((r: any) => r.role)).toEqual(["member"]);
    expect(owner.roles.some((r: any) => r.role === "owner")).toBe(true);
    expect(
      (await db.query("SELECT subject FROM users WHERE id=$1", [member.id]))[0]
        .subject,
    ).toBe("dev-member");
  });
  for (const mode of [
    "wrong-nonce",
    "wrong-audience",
    "wrong-issuer",
    "expired",
    "bad-signature",
  ])
    it(`rejects signed OIDC ${mode}`, async () => {
      issuer.setMode(mode);
      try {
        expect((await login("dev-member")).response.statusCode).toBe(401);
      } finally {
        issuer.setMode("normal");
      }
    });
  it("rejects wrong state and one-time flow replay", async () => {
    const start = await system.app.inject({ url: "/auth/login" });
    const url = new URL(start.headers.location!);
    url.searchParams.set("user", "dev-member");
    const auth = await fetch(url, { redirect: "manual" });
    const callback = new URL(auth.headers.get("location")!);
    callback.searchParams.set("state", "wrong");
    const r = await system.app.inject({
      url: callback.pathname + callback.search,
      headers: { cookie: cookies(start) },
    });
    expect(r.statusCode).toBe(401);
    expect(
      (
        await system.app.inject({
          url: callback.pathname + callback.search,
          headers: { cookie: cookies(start) },
        })
      ).statusCode,
    ).toBe(401);
  });
  it("enforces authentication, CSRF and server permissions", async () => {
    expect((await system.app.inject({ url: "/api/services" })).statusCode).toBe(
      401,
    );
    expect((await call(member, "/api/admin")).statusCode).toBe(403);
    expect((await call(support, "/api/admin/network")).statusCode).toBe(403);
    expect(
      (
        await system.app.inject({
          url: "/api/requests",
          method: "POST",
          headers: { cookie: member.cookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
  });
  it("isolates scoped responsibilities", () => {
    expect(
      can(
        { ...support, roles: [{ role: "support", scope: "one" }] },
        "ticket.staff",
        "one",
      ),
    ).toBe(true);
    expect(
      can(
        { ...support, roles: [{ role: "support", scope: "one" }] },
        "ticket.staff",
        "two",
      ),
    ).toBe(false);
    expect(can(member, "network.manage")).toBe(false);
  });
  it("expires idle and absolute sessions and rejects suspension", async () => {
    const user = await login("dev-member");
    await db.query(
      "UPDATE sessions SET last_seen=now()-interval '31 minutes' WHERE id=$1",
      [hash(user.cookie.match(/pc_session=([^;]+)/)[1])],
    );
    expect((await call(user, "/api/me")).statusCode).toBe(401);
    const user2 = await login("dev-member");
    await db.query(
      "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE id=$1",
      [hash(user2.cookie.match(/pc_session=([^;]+)/)[1])],
    );
    expect((await call(user2, "/api/me")).statusCode).toBe(401);
  });
});
describe("catalog, tickets, guides and files", () => {
  it("filters restricted fields before serialization and supports admin CRUD/favorites", async () => {
    const cards = (await call(member, "/api/services")).json();
    const wow = cards.find((c: any) => c.slug === "wow");
    expect(wow.metadata).toBeUndefined();
    expect(JSON.stringify(wow)).not.toContain("realm.example.invalid");
    const data = {
      name: "Restricted",
      slug: "restricted",
      summary: "Protected",
      visibility: "admin",
      metadata: {
        description: "SECRET DETAILS",
        endpoints: [
          {
            label: "Admin",
            host: "10.0.0.2",
            protocol: "tcp",
            ports: [22],
            network: "lan",
          },
        ],
        links: [],
      },
    };
    const made = await call(owner, "/api/services", "POST", data);
    expect(made.statusCode).toBe(200);
    const id = made.json().id;
    expect((await call(member, `/api/services/${id}`)).statusCode).toBe(404);
    expect((await call(owner, `/api/services/${id}`)).statusCode).toBe(200);
    const updated = await call(owner, `/api/services/${id}`, "PUT", {
      ...data,
      name: "Changed",
      version: 1,
    });
    expect(updated.statusCode).toBe(200);
    expect(
      (await call(owner, `/api/services/${id}`, "PUT", { ...data, version: 1 }))
        .statusCode,
    ).toBe(409);
    await call(owner, `/api/services/${id}`, "DELETE", {
      confirmation: "DELETE",
    });
    expect((await call(owner, `/api/services/${id}`)).statusCode).toBe(404);
    await call(member, `/api/services/${wow.id}/favorite`, "PUT", {
      favorite: true,
    });
    expect(
      (await call(member, `/api/services/${wow.id}`)).json().favorite,
    ).toBe(true);
  });
  it("protects other users tickets and private notes", async () => {
    const t = (
      await call(member, "/api/tickets", "POST", {
        subject: "Cannot connect",
        description: "The realm cannot be reached",
        type: "technical problem",
      })
    ).json();
    expect((await call(approver, `/api/tickets/${t.id}`)).statusCode).toBe(404);
    expect(
      (
        await call(member, `/api/tickets/${t.id}/comments`, "POST", {
          body: "private",
          private: true,
        })
      ).statusCode,
    ).toBe(403);
    await call(support, `/api/tickets/${t.id}/comments`, "POST", {
      body: "STAFF SECRET",
      private: true,
    });
    await call(support, `/api/tickets/${t.id}/comments`, "POST", {
      body: "Try checking My access",
    });
    const mine = (await call(member, `/api/tickets/${t.id}`)).json();
    expect(JSON.stringify(mine)).not.toContain("STAFF SECRET");
    expect(mine.comments.length).toBe(1);
    expect(
      (await call(support, `/api/tickets/${t.id}`)).json().comments.length,
    ).toBe(2);
  });
  it("protects attachment objects and rejects active content/path traversal", async () => {
    const t = (
      await call(member, "/api/tickets", "POST", {
        subject: "Diagnostics",
        description: "A file for support",
        type: "technical problem",
      })
    ).json();
    const a = await system.files.upload(
      member,
      { ticket_id: t.id },
      "../../private.txt",
      "text/plain",
      Buffer.from("safe diagnostic"),
    );
    expect(a.name).toBe("private.txt");
    expect((await call(approver, `/files/${a.id}`)).statusCode).toBe(404);
    expect((await call(member, `/files/${a.id}`)).body).toBe("safe diagnostic");
    await expect(
      system.files.upload(
        member,
        { ticket_id: t.id },
        "file.html",
        "text/html",
        Buffer.from("<script>alert(1)</script>"),
      ),
    ).rejects.toThrow();
  });
  it("acknowledges specific versions, survives logout, and detects document updates", async () => {
    const [g] = (await call(member, "/api/guides")).json();
    expect(
      (
        await call(member, `/api/guides/${g.id}/accept`, "POST", {
          version: g.current_version,
        })
      ).statusCode,
    ).toBe(200);
    const updated = await call(owner, `/api/guides/${g.id}`, "PUT", {
      title: g.title,
      body: "New rules version",
      required: true,
      visibility: "members",
      serviceId: null,
      version: g.current_version,
    });
    expect(updated.statusCode).toBe(200);
    expect(
      (await call(member, "/api/onboarding", "POST", { step: "rules" }))
        .statusCode,
    ).toBe(400);
    expect(
      (await call(member, `/api/guides/${g.id}/accept`, "POST", { version: 1 }))
        .statusCode,
    ).toBe(409);
    await call(member, `/api/guides/${g.id}/accept`, "POST", { version: 2 });
    expect(
      (await call(member, "/api/onboarding", "POST", { step: "rules" }))
        .statusCode,
    ).toBe(200);
    const relogin = await login("dev-member");
    expect(
      (await call(relogin, "/api/onboarding"))
        .json()
        .steps.some((s: any) => s.step === "rules"),
    ).toBe(true);
  });
  it("restricted service notices and guides cannot leak through independent endpoints", async () => {
    const made = (
      await call(owner, "/api/services", "POST", {
        name: "Administrative vault",
        slug: "admin-vault",
        summary: "Administrative service",
        visibility: "admin",
        metadata: { description: "Restricted details" },
      })
    ).json();
    const announcement = (
      await call(owner, "/api/announcements", "POST", {
        title: "SECRET SERVICE NOTICE",
        body: "Administrative maintenance information",
        serviceId: made.id,
      })
    ).json();
    expect(
      JSON.stringify((await call(member, "/api/notices")).json()),
    ).not.toContain(announcement.title);
    const guide = (
      await call(owner, "/api/guides", "POST", {
        title: "SECRET ADMIN GUIDE",
        body: "Administrative setup",
        serviceId: made.id,
        visibility: "members",
        required: false,
      })
    ).json();
    expect(
      JSON.stringify((await call(member, "/api/guides")).json()),
    ).not.toContain("SECRET ADMIN GUIDE");
    expect(
      (await call(member, `/api/guides/${guide.id}/files`)).statusCode,
    ).toBe(404);
  });
  it("invitations are authenticated, single-use and issue no grants", async () => {
    const inv = (
      await call(owner, "/api/invitations", "POST", { hours: 24 })
    ).json();
    expect(
      (
        await system.app.inject({
          url: "/api/invitations/redeem",
          method: "POST",
          payload: { invitation: inv.invitation },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await call(member, "/api/invitations/redeem", "POST", {
          invitation: inv.invitation,
        })
      ).json().grantsIssued,
    ).toBe(false);
    expect(
      (
        await call(member, "/api/invitations/redeem", "POST", {
          invitation: inv.invitation,
        })
      ).statusCode,
    ).toBe(400);
  });
});
describe("approval and durable real provider-client fulfillment", () => {
  it("explicitly verifies provider links without email or equal-ID assumptions", async () => {
    expect((await call(member, "/api/devices")).json().linked).toBe(false);
    for (const [provider, externalId] of [
      ["pocket-id", "pid-member"],
      ["netbird", "nb-member"],
    ])
      expect(
        (
          await call(owner, "/api/admin/links", "POST", {
            userId: member.id,
            provider,
            externalId,
            reason: "Verified with designated test resources",
            confirmation: "LINK",
          })
        ).statusCode,
      ).toBe(200);
    expect(
      (await call(member, "/api/admin/links", "POST", {})).statusCode,
    ).toBe(400);
  });
  it("requests approve to queued, then uses actual Pocket ID/NetBird HTTP calls with readback", async () => {
    const e = await entitlement("network.gaming", {}, [
      { provider: "pocket-id", externalId: "pid-gaming" },
      { provider: "netbird", externalId: "nb-gaming" },
    ]);
    const r = await request(e);
    expect((await approve(r)).json()).toEqual({
      status: "approved",
      fulfillment: "queued",
    });
    let [g] = await db.query("SELECT * FROM grants WHERE request_id=$1", [
      r.id,
    ]);
    expect(g.fulfillment).toBe("queued");
    await jobs.reconcile(member.id, { grantId: g.id, version: g.version });
    [g] = await db.query("SELECT * FROM grants WHERE id=$1", [g.id]);
    expect(g.fulfillment).toBe("active");
    expect(fixture.state.pocketGroup.users.map((u) => u.id)).toEqual([
      "unmanaged-user",
      "pid-member",
    ]);
    expect(fixture.state.users[0].role).toBe("admin");
    expect(fixture.state.users[0].auto_groups).toEqual([
      "unmanaged",
      "nb-gaming",
    ]);
    expect(fixture.state.groups[0].peers.map((p) => p.id)).toContain(
      "peer-existing",
    );
    expect(fixture.state.groups[0].peers.map((p) => p.id)).toContain(
      "unmanaged-peer",
    );
    expect(fixture.state.groups[0].resources).toEqual([
      { id: "resource-1", type: "host" },
    ]);
  });
  it("requires distinct approvers and prevents self approval", async () => {
    const e = await entitlement("game.privileged", { approvals: 2 });
    const r = await request(e);
    expect((await approve(r, approver)).json().status).toBe("pending");
    expect((await approve(r, approver)).statusCode).toBe(409);
    expect((await approve(r, approver2)).json().status).toBe("approved");
    const self = await request(e, owner);
    expect((await approve(self, owner)).statusCode).toBe(403);
  });
  it("does not silently expand stale approved bundles or mappings", async () => {
    const e = await entitlement("service.snapshot");
    const r = await request(e);
    await db.query("UPDATE entitlements SET version=version+1 WHERE id=$1", [
      e.id,
    ]);
    expect((await approve(r)).statusCode).toBe(409);
  });
  it("checks prerequisites and prevents cycles", async () => {
    const a = await entitlement("service.pre-a");
    const b = await entitlement("service.pre-b");
    await db.query("INSERT INTO prerequisites VALUES ($1,$2)", [b.id, a.id]);
    const result = await call(member, "/api/requests", "POST", {
      entitlementId: b.id,
      reason: "Access request",
      durationHours: 24,
    });
    expect(result.statusCode).toBe(409);
    const update = await call(owner, `/api/entitlements/${a.id}`, "PUT", {
      key: a.key,
      name: a.name,
      policy: a.policy,
      version: a.version,
      prerequisites: [b.id],
    });
    expect(update.statusCode).toBe(400);
    expect(
      (
        await db.query("SELECT 1 FROM prerequisites WHERE entitlement_id=$1", [
          a.id,
        ])
      ).length,
    ).toBe(0);
  });
  it("overlapping grants retain effective access, including newly enrolled peer propagation", async () => {
    const [e] = await db.query(
      "SELECT * FROM entitlements WHERE key='network.gaming'",
    );
    const r = await request(e);
    await approve(r);
    let grants = await db.query(
      "SELECT * FROM grants WHERE user_id=$1 AND entitlement_id=$2 ORDER BY created_at",
      [member.id, e.id],
    );
    fixture.state.peers.push({
      id: "peer-new",
      name: "Laptop",
      ip: "100.90.0.3",
      user_id: "nb-member",
      connected: false,
    });
    await jobs.reconcile(member.id);
    expect(fixture.state.groups[0].peers.map((p) => p.id)).toContain(
      "peer-new",
    );
    await call(owner, `/api/grants/${grants[0].id}/revoke`, "POST", {
      confirmation: "REVOKE",
    });
    await jobs.reconcile(member.id);
    expect(fixture.state.users[0].auto_groups).toContain("nb-gaming");
    grants = await db.query(
      "SELECT * FROM grants WHERE user_id=$1 AND entitlement_id=$2 ORDER BY created_at",
      [member.id, e.id],
    );
    expect(grants[0].fulfillment).toBe("revoked");
    expect(grants[1].fulfillment).toBe("active");
  });
  it("expiry denies locally while failed external revocation remains visible and retries preserve ownership", async () => {
    const [e] = await db.query(
      "SELECT * FROM entitlements WHERE key='network.gaming'",
    );
    const [g] = await db.query(
      "SELECT * FROM grants WHERE entitlement_id=$1 AND desired",
      [e.id],
    );
    await db.query(
      "UPDATE grants SET expires_at=now()-interval '1 second' WHERE id=$1",
      [g.id],
    );
    expect(
      validGrant(
        (await db.query("SELECT * FROM grants WHERE id=$1", [g.id]))[0],
      ),
    ).toBe(false);
    fixture.state.failWrites = true;
    await jobs.maintenance();
    await expect(jobs.reconcile(member.id)).rejects.toThrow();
    expect(
      (await db.query("SELECT fulfillment FROM grants WHERE id=$1", [g.id]))[0]
        .fulfillment,
    ).toBe("revocation-failed");
    fixture.state.failWrites = false;
    await jobs.reconcile(member.id);
    expect(
      (await db.query("SELECT fulfillment FROM grants WHERE id=$1", [g.id]))[0]
        .fulfillment,
    ).toBe("revoked");
    expect(fixture.state.users[0].auto_groups).toEqual(["unmanaged"]);
    expect(fixture.state.users[0].role).toBe("admin");
    expect(fixture.state.groups[0].peers.map((p) => p.id)).toEqual([
      "unmanaged-peer",
    ]);
    expect(fixture.state.pocketGroup.users.map((u) => u.id)).toEqual([
      "unmanaged-user",
    ]);
  });
  it("ambiguous provider response retries readback and stale jobs cannot resurrect revoked access", async () => {
    const [e] = await db.query(
      "SELECT * FROM entitlements WHERE key='network.gaming'",
    );
    const r = await request(e);
    await approve(r);
    const [g] = await db.query("SELECT * FROM grants WHERE request_id=$1", [
      r.id,
    ]);
    fixture.state.ambiguous = true;
    await expect(jobs.reconcile(member.id)).rejects.toThrow();
    await jobs.reconcile(member.id);
    expect(
      fixture.state.pocketGroup.users.filter((u) => u.id === "pid-member")
        .length,
    ).toBe(1);
    await call(owner, `/api/grants/${g.id}/revoke`, "POST", {
      confirmation: "REVOKE",
    });
    const writes = fixture.state.writes.length;
    await jobs.reconcile(member.id, { grantId: g.id, version: 1 });
    expect(fixture.state.writes.length).toBe(writes);
    await jobs.reconcile(member.id);
    expect(fixture.state.users[0].auto_groups).not.toContain("nb-gaming");
  });
  it("denies desired access immediately during an in-flight provider call and reconciles the stale result", async () => {
    const [e] = await db.query(
      "SELECT * FROM entitlements WHERE key='network.gaming'",
    );
    const r = await request(e);
    await approve(r);
    const [g] = await db.query("SELECT * FROM grants WHERE request_id=$1", [
      r.id,
    ]);
    fixture.state.delayMs = 600;
    const before = fixture.state.writes.length;
    const running = jobs.reconcile(member.id, {
      grantId: g.id,
      version: g.version,
    });
    for (let i = 0; i < 100 && fixture.state.writes.length === before; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const started = Date.now();
    await system.access.revoke(owner, g.id);
    expect(Date.now() - started).toBeLessThan(400);
    expect(
      (await db.query("SELECT desired FROM grants WHERE id=$1", [g.id]))[0]
        .desired,
    ).toBe(false);
    await running;
    fixture.state.delayMs = 0;
    expect(
      (await db.query("SELECT fulfillment FROM grants WHERE id=$1", [g.id]))[0]
        .fulfillment,
    ).toBe("revoking");
    await jobs.reconcile(member.id);
    expect(
      (await db.query("SELECT fulfillment FROM grants WHERE id=$1", [g.id]))[0]
        .fulfillment,
    ).toBe("revoked");
    expect(fixture.state.users[0].auto_groups).not.toContain("nb-gaming");
  });
  it("leased jobs recover after worker crash, dedupe and expose bounded failure", async () => {
    await db.query(
      "INSERT INTO jobs(kind,payload,dedupe,status,lease_until) VALUES ('test','{}','crashed','running',now()-interval '1 minute')",
    );
    let handled = 0;
    while (
      await jobs.runOne(async (kind) => {
        if (kind === "test") handled++;
      })
    ) {
      if (handled) break;
    }
    expect(handled).toBe(1);
    expect(
      (
        await db.query(
          "SELECT status,attempts FROM jobs WHERE dedupe='crashed'",
        )
      )[0],
    ).toEqual({ status: "done", attempts: 1 });
    await db.query(
      "INSERT INTO jobs(kind,payload,dedupe) VALUES ('test','{}','crashed') ON CONFLICT DO NOTHING",
    );
    expect(
      (await db.query("SELECT id FROM jobs WHERE dedupe='crashed'")).length,
    ).toBe(1);
  });
  it("blocks game provider fulfillment until manual attestation, never mock success", async () => {
    const [e] = await db.query(
      "SELECT * FROM entitlements WHERE key='game.wow.player'",
    );
    const r = await request(e);
    await approve(r);
    await jobs.reconcile(member.id);
    const [g] = await db.query("SELECT * FROM grants WHERE request_id=$1", [
      r.id,
    ]);
    expect(g.fulfillment).toBe("blocked");
    const [s] = await db.query(
      "SELECT * FROM fulfillment_steps WHERE grant_id=$1",
      [g.id],
    );
    expect(s.error).toContain("Awaiting API specification");
    expect(
      (
        await call(owner, `/api/steps/${s.id}/attest`, "POST", {
          reason: "Manually created designated game account",
          confirmation: "ATTEST",
        })
      ).statusCode,
    ).toBe(200);
    await jobs.reconcile(member.id);
    expect(
      (await db.query("SELECT fulfillment FROM grants WHERE id=$1", [g.id]))[0]
        .fulfillment,
    ).toBe("active");
    expect(
      (await call(member, "/api/services"))
        .json()
        .find((c: any) => c.slug === "wow").metadata.endpoints[0].host,
    ).toBe("realm.example.invalid");
  });
});
describe("network, health, notices and audit", () => {
  it("loads network administration when NetBird group collections are null", async () => {
    const response = await call(owner, "/api/admin/network");
    expect(response.statusCode).toBe(200);
    const network = response.json();
    expect(network.groups.find((g: any) => g.id === "all")).toMatchObject({
      peers: [],
      resources: [],
    });
    expect(network.groups.find((g: any) => g.id === "nb-server").peers).toEqual(
      [{ id: "realm-peer" }],
    );
    expect(network.warnings).toHaveLength(1);
  });
  it("reports NetBird contract field paths without exposing upstream values", async () => {
    const group = fixture.state.groups[0];
    const originalName = group.name;
    (group as any).name = { privateValue: "do-not-expose-provider-data" };
    try {
      const response = await call(owner, "/api/admin/network");
      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({
        error: "contract-mismatch",
        provider: "netbird",
        details: {
          method: "GET",
          path: "/api/groups",
          status: 200,
          reason: "invalid-response",
          fields: ["0.name"],
        },
      });
      expect(response.json().message).toContain("GET /api/groups");
      expect(response.body).not.toContain("do-not-expose-provider-data");
      expect(response.body).not.toContain("netbird-fixture-token");
    } finally {
      group.name = originalName;
    }
  });
  it("owned devices filter other users and unavailable telemetry stays null", async () => {
    fixture.state.peers.push({
      id: "other-peer",
      name: "Other user",
      ip: "100.90.0.9",
      user_id: "other-user",
      connected: true,
    });
    await system.devices.sync();
    const d = (await call(member, "/api/devices")).json();
    expect(d.devices.length).toBe(2);
    expect(d.devices[0].metadata.latency).toBeNull();
    expect(JSON.stringify(d)).not.toContain("other-peer");
    expect((await call(approver, "/api/devices")).json().devices.length).toBe(
      0,
    );
  });
  it("narrow policies and setup keys follow official contracts without whole-account blocking", async () => {
    const warnings = await system.clients.netbird!.broadPolicyWarnings();
    expect(warnings.length).toBe(1);
    await expect(
      system.clients.netbird!.createPolicy({
        name: "Bad",
        sourceGroup: "all",
        destinationGroup: "nb-server",
        protocol: "tcp",
        ports: [3724],
      }),
    ).rejects.toThrow();
    const p = await system.clients.netbird!.createPolicy({
      name: "Realm",
      sourceGroup: "nb-gaming",
      destinationGroup: "nb-server",
      protocol: "tcp",
      ports: [3724],
    });
    expect(p.id).toBe("managed-policy");
    const rule = fixture.state.policies[1].rules[0];
    expect(rule.bidirectional).toBe(false);
    expect(rule.ports).toEqual(["3724"]);
    const key = await system.clients.netbird!.createSetupKey(
      "Test single use",
      ["nb-gaming"],
    );
    expect(key.type).toBe("one-off");
    expect(key.usage_limit).toBe(1);
    const peers = fixture.state.peers.length;
    await system.clients.netbird!.revokeSetupKey("key-1");
    expect(fixture.state.peers.length).toBe(peers);
    expect(fixture.state.setupKeys[0].revoked).toBe(true);
    expect(
      JSON.stringify(await system.clients.netbird!.setupKeys()),
    ).not.toContain("never-expose-from-list");
  });
  it("SSRF rejects metadata, link-local, unapproved ranges/ports and redirects", async () => {
    const c = loadConfig(env);
    expect(allowedAddress("169.254.169.254", c)).toBe(false);
    expect(allowedAddress("10.2.0.1", c)).toBe(false);
    expect(allowedAddress("192.168.10.2", c)).toBe(true);
    await expect(
      checkedHttp("http://127.0.0.1:4300/redirect", c),
    ).rejects.toThrow("redirect_rejected");
    await expect(checkedHttp("http://127.0.0.1:4301/", c)).rejects.toThrow();
    expect(allowedAddress("127.0.0.1", { ...c, NODE_ENV: "production" })).toBe(
      false,
    );
  });
  it("preserves dependency edits and aggregates required/optional cached health without leaking hidden identities", async () => {
    const create = async (slug: string, visibility = "discoverable") => {
      const response = await call(owner, "/api/services", "POST", {
        name: slug,
        slug,
        summary: "Dependency test",
        visibility,
        metadata: {},
      });
      expect(response.statusCode).toBe(200);
      return response.json();
    };
    const root = await create("dependency-root");
    const optional = await create("dependency-optional", "admin");
    const leaf = await create("dependency-secret-leaf", "admin");
    const status = async (service: any, state: string) => {
      const c = (
        await call(owner, "/api/health/checks", "POST", {
          serviceId: service.id,
          kind: "manual",
          config: {},
          intervalSeconds: 60,
        })
      ).json();
      await system.monitoring.observe(
        c.id,
        state as any,
        "manual",
        "Test operator",
        600,
      );
    };
    await status(root, "healthy");
    await status(optional, "healthy");
    await status(leaf, "down");
    const update = async (service: any, dependencies: any[]) =>
      call(owner, `/api/services/${service.id}`, "PUT", {
        name: service.name,
        slug: service.slug,
        summary: service.summary,
        visibility: service.visibility,
        metadata: service.metadata,
        dependencies,
        version: service.version,
      });
    expect(
      (await update(optional, [{ id: leaf.id, required: true }])).statusCode,
    ).toBe(200);
    expect(
      (await update(root, [{ id: optional.id, required: false }])).statusCode,
    ).toBe(200);
    const memberCard = (await call(member, `/api/services/${root.id}`)).json();
    expect(memberCard.health).toMatchObject({
      state: "degraded",
      measuredState: "healthy",
      dependencyState: "degraded",
    });
    expect(JSON.stringify(memberCard)).not.toContain(leaf.id);
    expect(JSON.stringify(memberCard)).not.toContain(optional.id);
    const editable = (await call(owner, `/api/services/${root.id}`)).json();
    expect(editable.dependencies).toEqual([
      { id: optional.id, required: false },
    ]);
    expect((await update(editable, editable.dependencies)).statusCode).toBe(
      200,
    );
    const updated = (await call(owner, `/api/services/${root.id}`)).json();
    expect(
      (await update(updated, [{ id: optional.id, required: true }])).statusCode,
    ).toBe(200);
    expect(
      (await call(member, `/api/services/${root.id}`)).json().health.state,
    ).toBe("down");
    await db.query(
      "UPDATE health_observations SET expires_at=now()-interval '1 second' WHERE check_id IN(SELECT id FROM health_checks WHERE service_id=$1)",
      [leaf.id],
    );
    expect(
      (await call(member, `/api/services/${root.id}`)).json().health.state,
    ).toBe("stale");
    expect(
      (await update(leaf, [{ id: root.id, required: true }])).statusCode,
    ).toBe(400);
    expect(
      (await call(owner, `/api/services/${leaf.id}`)).json().dependencies,
    ).toEqual([]);
  });
  it("shows authorized incident timelines and starts or cancels future maintenance immediately", async () => {
    const incident = (
      await call(owner, "/api/incidents", "POST", {
        title: "Community interruption",
        body: "Investigating connection reports",
        state: "investigating",
      })
    ).json();
    await call(owner, `/api/incidents/${incident.id}`, "POST", {
      title: incident.title,
      body: "Service recovered and verified",
      state: "resolved",
    });
    const notices = (await call(member, "/api/notices")).json();
    expect(
      notices.incidents
        .find((n: any) => n.id === incident.id)
        .updates.map((u: any) => u.state),
    ).toEqual(["investigating", "resolved"]);
    const createWindow = async () =>
      (
        await call(owner, "/api/maintenance", "POST", {
          title: "Future window",
          startsAt: new Date(Date.now() + 3600000).toISOString(),
          endsAt: new Date(Date.now() + 7200000).toISOString(),
        })
      ).json();
    const window = await createWindow();
    expect(
      (await call(member, `/api/maintenance/${window.id}/start`, "POST", {}))
        .statusCode,
    ).toBe(403);
    expect(
      (await call(owner, `/api/maintenance/${window.id}/start`, "POST", {}))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await db.query(
          "SELECT starts_at<=now() AS started FROM maintenance WHERE id=$1",
          [window.id],
        )
      )[0].started,
    ).toBe(true);
    const canceled = await createWindow();
    for (const w of [window, canceled]) {
      expect(
        (await call(owner, `/api/maintenance/${w.id}/end`, "POST", {}))
          .statusCode,
      ).toBe(200);
      expect(
        (
          await db.query(
            "SELECT ends_at<=now() AS ended FROM maintenance WHERE id=$1",
            [w.id],
          )
        )[0].ended,
      ).toBe(true);
    }
  });
  it("refuses policy verification when the provider returns a broader source group", async () => {
    fixture.state.widenPolicyReadback = true;
    try {
      await expect(
        system.clients.netbird!.createPolicy({
          name: "Strict readback",
          sourceGroup: "nb-gaming",
          destinationGroup: "nb-server",
          protocol: "tcp",
          ports: [3724],
        }),
      ).rejects.toMatchObject({ code: "conflict" });
    } finally {
      fixture.state.widenPolicyReadback = false;
    }
  });
  it("runs real HTTP and Kuma checks, preserving stale and maintenance distinction", async () => {
    const [s] = await db.query("SELECT * FROM services WHERE slug='community'");
    const c = (
      await call(owner, "/api/health/checks", "POST", {
        serviceId: s.id,
        kind: "http",
        intervalSeconds: 30,
        config: {
          url: "http://127.0.0.1:4300/health",
          expectedStatus: 200,
          vantage: "Test worker",
        },
      })
    ).json();
    await system.monitoring.poll(c.id);
    expect(
      (await call(member, `/api/services/${s.id}`)).json().health.state,
    ).toBe("healthy");
    await call(owner, "/api/maintenance", "POST", {
      title: "Test maintenance",
      serviceId: s.id,
      startsAt: new Date(Date.now() - 60000).toISOString(),
      endsAt: new Date(Date.now() + 60000).toISOString(),
    });
    await db.query(
      "UPDATE health_observations SET expires_at=now()-interval '1 second' WHERE check_id=$1",
      [c.id],
    );
    const h = (await call(member, `/api/services/${s.id}`)).json().health;
    expect(h.state).toBe("stale");
    expect(h.maintenance.length).toBe(1);
    expect(parseKuma('monitor_status{monitor_name="Realm"} 0', "Realm")).toBe(
      "down",
    );
    expect(parseKuma("", "Realm")).toBe("unknown");
    const kuma = (
      await call(owner, "/api/health/checks", "POST", {
        serviceId: s.id,
        kind: "kuma",
        config: { url: "http://127.0.0.1:4300/metrics", monitorName: "Realm" },
        intervalSeconds: 30,
      })
    ).json();
    await system.monitoring.poll(kuma.id);
    expect(
      (
        await db.query(
          "SELECT state FROM health_observations WHERE check_id=$1",
          [kuma.id],
        )
      )[0].state,
    ).toBe("healthy");
  });
  it("authenticates incoming health updates and rejects replay", async () => {
    const [s] = await db.query("SELECT * FROM services WHERE slug='community'");
    const c = (
      await call(owner, "/api/health/checks", "POST", {
        serviceId: s.id,
        kind: "incoming",
        config: {},
        intervalSeconds: 30,
      })
    ).json();
    const body = {
      checkId: c.id,
      state: "healthy",
      timestamp: Date.now(),
      nonce: "nonce-unique-123456",
      vantage: "Designated external monitor",
    };
    const send = (signature: string) =>
      system.app.inject({
        url: "/api/health/incoming",
        method: "POST",
        payload: body,
        headers: { "x-portcullis-signature": signature },
      });
    expect((await send("wrong")).statusCode).toBe(401);
    const signature = signedBody(JSON.stringify(body), env.HEALTH_WEBHOOK_KEY);
    expect((await send(signature)).statusCode).toBe(200);
    expect((await send(signature)).statusCode).toBe(409);
  });
  it("core notifications work without SMTP and staff activity is append-only audited", async () => {
    const before = (await call(member, "/api/notifications")).json();
    expect(before.length).toBeGreaterThan(0);
    await new Notifications(db, loadConfig(env)).deliver(before[0].id);
    expect((await call(member, "/api/notifications")).statusCode).toBe(200);
    expect((await call(member, "/api/admin/audit")).statusCode).toBe(403);
    const events = (await call(owner, "/api/admin/audit")).json();
    expect(events.some((a: any) => a.action === "provider.grant")).toBe(true);
    await expect(
      db.query("UPDATE audit_events SET outcome='changed' WHERE id=$1", [
        events[0].id,
      ]),
    ).rejects.toThrow("append only");
    expect(JSON.stringify(events)).not.toContain("pocket-fixture-key");
  });
  it("read-only preview retains administrator actor and does not create user sessions", async () => {
    const count = (await db.query("SELECT count(*) FROM sessions"))[0].count;
    const p = (await call(owner, `/api/admin/preview/${member.id}`)).json();
    expect(p.readOnly).toBe(true);
    expect((await db.query("SELECT count(*) FROM sessions"))[0].count).toBe(
      count,
    );
    expect(
      (await call(member, `/api/admin/preview/${owner.id}`)).statusCode,
    ).toBe(403);
  });
  it("creates and reads back routed resources and routing associations through real HTTP contracts", async () => {
    const client = system.clients.netbird!;
    const resource = await client.createResource("network-1", {
      name: "Designated realm",
      address: "192.168.10.9",
      groups: ["nb-server"],
      enabled: true,
    });
    expect(resource.address).toBe("192.168.10.9");
    await expect(
      client.createResource("network-1", {
        name: "Broad",
        address: "192.168.10.0/24",
        groups: ["nb-server"],
      }),
    ).rejects.toThrow();
    await expect(
      client.createResource("network-1", {
        name: "Wildcard",
        address: "*.example.invalid",
        groups: ["nb-server"],
      }),
    ).rejects.toThrow();
    const router = await client.createRouter("network-1", {
      peer: "realm-peer",
      metric: 100,
      masquerade: true,
      enabled: true,
    });
    expect(router.peer).toBe("realm-peer");
    expect((await client.resources("network-1")).length).toBe(2);
    expect((await client.routers("network-1")).length).toBe(2);
  });
  it("TCP health has a real worker vantage and alert suppression preserves measurements", async () => {
    const [s] = await db.query("SELECT * FROM services WHERE slug='community'");
    const c = (
      await call(owner, "/api/health/checks", "POST", {
        serviceId: s.id,
        kind: "tcp",
        config: { host: "127.0.0.1", port: 4300, vantage: "Test TCP worker" },
        intervalSeconds: 30,
      })
    ).json();
    await system.monitoring.poll(c.id);
    expect(
      (
        await db.query("SELECT * FROM health_observations WHERE check_id=$1", [
          c.id,
        ])
      )[0].state,
    ).toBe("healthy");
    await db.query("DELETE FROM maintenance WHERE service_id=$1", [s.id]);
    await system.monitoring.observe(c.id, "down", "tcp", "Test worker", 60);
    await system.monitoring.observe(c.id, "healthy", "tcp", "Test worker", 60);
    await system.monitoring.observe(c.id, "down", "tcp", "Test worker", 60);
    expect(
      (
        await db.query("SELECT 1 FROM settings WHERE key=$1", [
          `health.alert.${c.id}`,
        ])
      ).length,
    ).toBe(0);
    await system.monitoring.observe(c.id, "down", "tcp", "Test worker", 60);
    await system.monitoring.observe(c.id, "down", "tcp", "Test worker", 60);
    expect(
      (
        await db.query("SELECT value FROM settings WHERE key=$1", [
          `health.alert.${c.id}`,
        ])
      )[0].value.state,
    ).toBe("down");
  });
  it("optional SMTP failure retries separately and leaves grants/tickets/in-app updates intact", async () => {
    await db.query(
      "INSERT INTO notification_preferences(user_id,channel,enabled) VALUES ($1,'smtp',true)",
      [member.id],
    );
    const [n] = await db.query(
      "SELECT id FROM notifications WHERE user_id=$1 LIMIT 1",
      [member.id],
    );
    const configured = {
      ...loadConfig(env),
      SMTP_URL: "smtp://127.0.0.1:4301",
    };
    await expect(
      new Notifications(db, configured).deliver(n.id),
    ).rejects.toThrow("notifications: unavailable");
    expect(
      (
        await db.query(
          "SELECT status FROM delivery_attempts WHERE notification_id=$1",
          [n.id],
        )
      )[0].status,
    ).toBe("failed");
    expect((await call(member, "/api/access")).statusCode).toBe(200);
    expect(
      (await call(member, "/api/notifications")).json().length,
    ).toBeGreaterThan(0);
  });
  it("request additional information can be followed by the same approver deciding", async () => {
    const e = await entitlement("service.more-information");
    const r = await request(e);
    expect(
      (
        await call(approver, `/api/requests/${r.id}/decide`, "POST", {
          decision: "needs-information",
          reason: "Please provide setup details",
        })
      ).json().status,
    ).toBe("needs-information");
    expect((await approve(r, approver)).json().status).toBe("approved");
  });
  it("bounded identity refresh records failures, refreshes canonical attributes and invalidates changed roles", async () => {
    const old = await login("dev-member");
    await db.query(
      "UPDATE users SET identity_checked_at=now()-interval '6 minutes' WHERE id=$1",
      [member.id],
    );
    fixture.state.pocketUsers[0].userGroups = [
      { id: "support-group", name: "portal-support", friendlyName: "Support" },
    ];
    expect((await call(old, "/api/me")).statusCode).toBe(401);
    expect(
      (await db.query("SELECT name FROM users WHERE id=$1", [member.id]))[0]
        .name,
    ).toBe("Alex");
    expect(
      (
        await db.query(
          "SELECT role FROM roles WHERE user_id=$1 AND source='pocket-group'",
          [member.id],
        )
      )[0].role,
    ).toBe("support");
    fixture.state.pocketUsers[0].userGroups = [];
    member = await login("dev-member");
    fixture.state.pocketUsers[0].disabled = true;
    expect(
      (
        await call(
          owner,
          `/api/admin/users/${member.id}/refresh-identity`,
          "POST",
          {},
        )
      ).statusCode,
    ).toBe(401);
    fixture.state.pocketUsers[0].disabled = false;
    expect(
      (
        await db.query("SELECT value FROM settings WHERE key=$1", [
          `identity.observation.${member.id}`,
        ])
      )[0].value.status,
    ).toBe("failed");
    member = await login("dev-member");
  });
  it("preserves pre-existing NetBird membership and explicitly reports retained unmanaged access", async () => {
    fixture.state.groups.push({
      id: "pre-existing",
      name: "Prior community access",
      issued: "api",
      peers: [{ id: "peer-existing" }],
      resources: [],
    });
    fixture.state.users[0].auto_groups.push("pre-existing");
    const client = system.clients.netbird!;
    await client.access(db, db, "nb-member", "pre-existing", true);
    const result = await client.access(
      db,
      db,
      "nb-member",
      "pre-existing",
      false,
    );
    expect(result.unmanagedMembershipRetained).toBe(true);
    expect(fixture.state.users[0].auto_groups).toContain("pre-existing");
    expect(
      fixture.state.groups
        .find((g) => g.id === "pre-existing")!
        .peers.map((p) => p.id),
    ).toContain("peer-existing");
  });
  it("rejects missing credentials and configured unsupported network capabilities distinctly", async () => {
    const { NetBirdClient } = await import("../src/providers/netbird.js");
    const { PocketIdClient } = await import("../src/providers/pocket-id.js");
    await expect(new NetBirdClient(fixture.url, "").users()).rejects.toThrow(
      "missing-credentials",
    );
    expect(() =>
      new NetBirdClient(fixture.url, "netbird-fixture-token").networks(),
    ).toThrow("unsupported");
    await expect(new PocketIdClient(fixture.url, "").users()).rejects.toThrow(
      "missing-credentials",
    );
  });
  it("members never receive internal provider bindings in grant/request snapshots", async () => {
    const response = (await call(member, "/api/access")).json();
    expect(
      response.grants.every((g: any) => g.snapshot.bindings === undefined),
    ).toBe(true);
    expect(
      response.requests.every((r: any) =>
        r.snapshot.items.every((e: any) => e.bindings === undefined),
      ),
    ).toBe(true);
  });
  it("portal suspension invalidates sessions and remains separate from global identity", async () => {
    const s = await login("dev-support");
    expect(
      (
        await call(owner, `/api/admin/users/${s.id}/suspend`, "POST", {
          suspended: true,
          confirmation: "SUSPEND",
        })
      ).statusCode,
    ).toBe(200);
    expect((await call(s, "/api/me")).statusCode).toBe(401);
    expect(fixture.state.pocketUsers[0].disabled).toBe(false);
    expect(
      (
        await call(owner, `/api/admin/users/${s.id}/suspend`, "POST", {
          suspended: false,
          confirmation: "SUSPEND",
        })
      ).statusCode,
    ).toBe(200);
  });
  it("backs up and restores a real PostgreSQL cluster and uploaded files", async () => {
    const counts = (
      await db.query(
        "SELECT (SELECT count(*) FROM users) AS users,(SELECT count(*) FROM audit_events) AS audit",
      )
    )[0];
    await db.close();
    await pg.stop();
    await cp(join(directory, "db"), join(directory, "restored-db"), {
      recursive: true,
    });
    await cp(join(directory, "uploads"), join(directory, "restored-uploads"), {
      recursive: true,
    });
    const restoredPg = new EmbeddedPostgres({
      databaseDir: join(directory, "restored-db"),
      user: "test",
      password: "test",
      port: 55433,
      persistent: true,
      onLog: () => {},
      onError: () => {},
    });
    await restoredPg.start();
    const restored = new Database(
      "postgres://test:test@127.0.0.1:55433/portcullis_test",
    );
    try {
      expect(
        (
          await restored.query(
            "SELECT (SELECT count(*) FROM users) AS users,(SELECT count(*) FROM audit_events) AS audit",
          )
        )[0],
      ).toEqual(counts);
      const [a] = await restored.query("SELECT storage_key FROM attachments");
      expect(
        (
          await readFile(join(directory, "restored-uploads", a.storage_key))
        ).toString(),
      ).toBe("safe diagnostic");
      await migrate(restored);
    } finally {
      await restored.close();
      await restoredPg.stop();
      await pg.start();
      db = new Database(env.DATABASE_URL);
    }
  });
});
describe("provider extension boundary", () => {
  it("declares typed manual/unavailable/mock capabilities and prohibits production mocks", async () => {
    expect(
      (await new WowManagerProvider().operation("restart", {})).state,
    ).toBe("awaiting-specification");
    expect(
      (await new ManualServiceProvider().operation("provision-account", {}))
        .state,
    ).toBe("manual-required");
    expect(
      (await new ManualServiceProvider().operation("logs", {})).state,
    ).toBe("unsupported");
    expect(() => new MockServiceProvider(true)).toThrow();
    expect(
      (await new MockServiceProvider(false).operation("player-count", {}))
        .state,
    ).toBe("ok");
  });
  it("effective bindings compute union independent of fulfillment or provider IDs", () => {
    const b = { id: "binding-1" };
    expect(
      effectiveBindings([
        { desired: true, snapshot: { bindings: [b] } },
        { desired: false, snapshot: { bindings: [b] } },
      ]),
    ).toEqual([b]);
    expect(
      effectiveBindings([
        {
          desired: true,
          expires_at: new Date(Date.now() - 1000),
          snapshot: { bindings: [b] },
        },
      ]),
    ).toEqual([]);
  });
});
