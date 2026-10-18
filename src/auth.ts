import * as oidc from "openid-client";
import "@fastify/cookie";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { Database } from "./db/index.js";
import type { Config } from "./config.js";
import type { Actor, Role } from "./domain/authorization.js";
import {
  hash,
  token,
  encrypt,
  decrypt,
  equal,
  stableJson,
} from "./security.js";
import { invariant } from "./errors.js";
import { audit } from "./domain/audit.js";
import { invalidate } from "./domain/authorization.js";
import type { PocketIdClient } from "./providers/pocket-id.js";

declare module "fastify" {
  interface FastifyRequest {
    actor: Actor;
  }
}
export class Auth {
  private oidcConfig?: oidc.Configuration;
  constructor(
    readonly db: Database,
    readonly config: Config,
    readonly pocket?: PocketIdClient,
  ) {}
  async discovery() {
    this.oidcConfig ??= await oidc.discovery(
      new URL(this.config.OIDC_ISSUER),
      this.config.OIDC_CLIENT_ID,
      this.config.OIDC_CLIENT_SECRET,
      undefined,
      this.config.NODE_ENV === "production"
        ? undefined
        : { execute: [oidc.allowInsecureRequests] },
    );
    invariant(
      this.oidcConfig.serverMetadata().issuer === this.config.OIDC_ISSUER,
      "issuer_mismatch",
    );
    oidc.enableNonRepudiationChecks(this.oidcConfig);
    return this.oidcConfig;
  }
  cookie(reply: FastifyReply, name: string, value: string, maxAge: number) {
    reply.setCookie(name, value, {
      httpOnly: true,
      secure: this.config.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge,
    });
  }
  async issue(reply: FastifyReply, user: any, authTime = new Date()) {
    const sid = token();
    const csrf = token();
    await this.db.query(
      "INSERT INTO sessions(id,user_id,csrf,auth_version,authenticated_at,expires_at) VALUES ($1,$2,$3,$4,$5,now()+interval '8 hours')",
      [hash(sid), user.id, csrf, user.auth_version, authTime],
    );
    this.cookie(reply, "pc_session", sid, 8 * 3600);
  }
  async actor(request: FastifyRequest) {
    const sid = request.cookies.pc_session;
    invariant(sid, "unauthenticated", 401);
    const [row] = await this.db.query(
      `SELECT u.*, s.id AS session_id, s.csrf, s.authenticated_at, s.auth_version AS session_version FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.expires_at>now() AND s.last_seen>now()-interval '30 minutes'`,
      [hash(sid)],
    );
    invariant(
      row && !row.suspended && row.auth_version === row.session_version,
      "session_expired",
      401,
    );
    if (
      !row.identity_checked_at ||
      Date.now() - new Date(row.identity_checked_at).getTime() > 5 * 60 * 1000
    ) {
      // Refresh privileges from directory rather than retaining old signed group claims indefinitely.
      if (!this.pocket) {
        await this.db.query("DELETE FROM sessions WHERE id=$1", [hash(sid)]);
        invariant(false, "identity_refresh_requires_login", 401);
      }
      const changed = await this.refreshIdentity(row.id);
      invariant(!changed, "identity_permissions_changed", 401);
    }
    const roles = await this.db.query<{ role: Role; scope: string }>(
      "SELECT role,scope FROM roles WHERE user_id=$1",
      [row.id],
    );
    await this.db.query("UPDATE sessions SET last_seen=now() WHERE id=$1", [
      hash(sid),
    ]);
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      timezone: row.timezone,
      roles,
      csrf: row.csrf,
      sessionId: row.session_id,
      authenticatedAt: new Date(row.authenticated_at),
    } satisfies Actor;
  }
  async updateGroups(user: string, groups: string[]) {
    const mappings = JSON.parse(this.config.ROLE_GROUP_MAPPINGS) as Record<
      string,
      Role[]
    >;
    return this.db.transaction(async (tx) => {
      await tx.userLock(user);
      const before = await tx.query(
        "SELECT role FROM roles WHERE user_id=$1 AND source='pocket-group' ORDER BY role",
        [user],
      );
      const desired = [
        ...new Set(groups.flatMap((g) => mappings[g] ?? [])),
      ].sort();
      const changed =
        stableJson(before.map((r) => r.role)) !== stableJson(desired);
      await tx.query(
        "DELETE FROM roles WHERE user_id=$1 AND source='pocket-group'",
        [user],
      );
      for (const role of desired)
        await tx.query(
          "INSERT INTO roles(user_id,role,source) VALUES ($1,$2,'pocket-group') ON CONFLICT DO NOTHING",
          [user, role],
        );
      if (changed) {
        await invalidate(tx, user);
        await audit(
          tx,
          null,
          "identity.roles.refresh",
          user,
          { before: before.map((r) => r.role), after: desired },
          user,
        );
      }
      return changed;
    });
  }
  async refreshIdentity(user: string) {
    invariant(this.pocket, "identity_client_not_configured", 503);
    const [u] = await this.db.query(
      "SELECT u.*,l.external_id FROM users u LEFT JOIN identity_links l ON l.user_id=u.id AND l.provider='pocket-id' WHERE u.id=$1",
      [user],
    );
    invariant(u, "not_found", 404);
    try {
      const id = u.external_id ?? u.subject;
      const external = await this.pocket.user(id);
      invariant(external.id === id, "identity_contract_mismatch", 502);
      if (external.disabled) {
        await invalidate(this.db, user);
        invariant(false, "identity_disabled", 401);
      }
      const changed = await this.updateGroups(
        user,
        external.userGroups.map((g) => g.name),
      );
      await this.db.query(
        "UPDATE users SET name=$1,email=$2,identity_checked_at=now() WHERE id=$3",
        [external.displayName, external.email ?? null, user],
      );
      await this.db.query(
        "INSERT INTO settings(key,value) VALUES ($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",
        [
          `identity.observation.${user}`,
          JSON.stringify({
            status: "observed",
            observedAt: new Date().toISOString(),
          }),
        ],
      );
      return changed;
    } catch (e) {
      await this.db.query(
        "INSERT INTO settings(key,value) VALUES ($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",
        [
          `identity.observation.${user}`,
          JSON.stringify({
            status: "failed",
            error: "identity_refresh_failed",
            observedAt: new Date().toISOString(),
          }),
        ],
      );
      throw e;
    }
  }
  csrf(request: FastifyRequest) {
    invariant(
      request.headers.origin === this.config.BASE_URL,
      "origin_rejected",
      403,
    );
    invariant(
      typeof request.headers["x-csrf-token"] === "string" &&
        equal(request.actor.csrf, request.headers["x-csrf-token"]),
      "csrf_rejected",
      403,
    );
  }
  register(app: FastifyInstance) {
    app.get("/auth/login", async (request, reply) => {
      const c = await this.discovery();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const verifier = oidc.randomPKCECodeVerifier();
      const flow = token();
      await this.db.query(
        "INSERT INTO oidc_flows(id,data,expires_at) VALUES ($1,$2,now()+interval '5 minutes')",
        [
          hash(flow),
          encrypt(
            JSON.stringify({ state, nonce, verifier }),
            this.config.ENCRYPTION_KEY,
          ),
        ],
      );
      this.cookie(reply, "pc_flow", flow, 300);
      return reply.redirect(
        oidc.buildAuthorizationUrl(c, {
          redirect_uri: `${this.config.BASE_URL}/auth/callback`,
          scope: "openid profile email groups",
          state,
          nonce,
          code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
          code_challenge_method: "S256",
          max_age: "0",
        }).href,
      );
    });
    app.get("/auth/callback", async (request, reply) => {
      invariant(request.cookies.pc_flow, "invalid_login_flow", 401);
      const [flow] = await this.db.query(
        "DELETE FROM oidc_flows WHERE id=$1 AND expires_at>now() RETURNING data",
        [hash(request.cookies.pc_flow)],
      );
      invariant(flow, "invalid_login_flow", 401);
      reply.clearCookie("pc_flow", { path: "/" });
      const { state, nonce, verifier } = JSON.parse(
        decrypt(flow.data, this.config.ENCRYPTION_KEY),
      );
      const c = await this.discovery();
      let result;
      try {
        result = await oidc.authorizationCodeGrant(
          c,
          new URL(request.url, this.config.BASE_URL),
          {
            expectedState: state,
            expectedNonce: nonce,
            pkceCodeVerifier: verifier,
            idTokenExpected: true,
          },
        );
      } catch {
        invariant(false, "invalid_oidc_response", 401);
      }
      const claims = result.claims();
      invariant(
        claims?.sub && claims.iss === this.config.OIDC_ISSUER,
        "invalid_identity",
        401,
      );
      const groups = Array.isArray(claims.groups)
        ? claims.groups.filter((g): g is string => typeof g === "string")
        : [];
      const [user] = await this.db.query(
        `INSERT INTO users(issuer,subject,name,email,identity_checked_at) VALUES ($1,$2,$3,$4,now()) ON CONFLICT(issuer,subject) DO UPDATE SET name=EXCLUDED.name,email=EXCLUDED.email,identity_checked_at=now() RETURNING *`,
        [
          claims.iss,
          claims.sub,
          typeof claims.name === "string" ? claims.name : claims.sub,
          typeof claims.email === "string" ? claims.email : null,
        ],
      );
      invariant(!user.suspended, "portal_suspended", 403);
      await this.db.query(
        "INSERT INTO roles(user_id,role) VALUES ($1,'member') ON CONFLICT DO NOTHING",
        [user.id],
      );
      if (claims.sub === this.config.OWNER_SUBJECT)
        await this.db.query(
          "INSERT INTO roles(user_id,role,source) VALUES ($1,'owner','bootstrap') ON CONFLICT DO NOTHING",
          [user.id],
        );
      await this.updateGroups(user.id, groups);
      if (request.cookies.pc_session)
        await this.db.query("DELETE FROM sessions WHERE id=$1", [
          hash(request.cookies.pc_session),
        ]);
      const [currentUser] = await this.db.query(
        "SELECT * FROM users WHERE id=$1",
        [user.id],
      );
      await this.issue(reply, currentUser);
      await audit(this.db, user.id, "login", user.id);
      return reply.redirect("/");
    });
    app.post("/auth/logout", async (request, reply) => {
      request.actor = await this.actor(request);
      this.csrf(request);
      await this.db.query("DELETE FROM sessions WHERE id=$1", [
        request.actor.sessionId,
      ]);
      reply.clearCookie("pc_session", { path: "/" });
      return { ok: true };
    });
  }
}
