import Fastify from "fastify";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { randomUUID, createHash } from "node:crypto";
export async function devIssuer(port = 4100) {
  if (process.env.NODE_ENV === "production")
    throw new Error("Development issuer forbidden in production");
  const app = Fastify();
  const keys = await generateKeyPair("RS256");
  const wrong = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(keys.publicKey)),
    kid: "development-key",
    alg: "RS256",
    use: "sig",
  };
  const issuer = `http://localhost:${port}`;
  const codes = new Map<string, any>();
  let mode = "normal";
  app.get("/.well-known/openid-configuration", () => ({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    token_endpoint_auth_methods_supported: [
      "client_secret_post",
      "client_secret_basic",
    ],
    code_challenge_methods_supported: ["S256"],
  }));
  app.get("/jwks", () => ({ keys: [jwk] }));
  app.get("/authorize", async (r, reply) => {
    const q = r.query as any;
    if (q.user) {
      if (
        ![
          "dev-owner",
          "dev-member",
          "dev-support",
          "dev-approver",
          "dev-approver-2",
        ].includes(q.user)
      )
        return reply.code(400).send({ error: "Unknown fictional user" });
      const code = randomUUID();
      codes.set(code, { ...q, mode });
      const callback = new URL(q.redirect_uri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", q.state);
      return reply.redirect(callback.href);
    }
    reply.type("text/html");
    const query = new URLSearchParams(q);
    return `<html><body><h1>Development identity provider</h1><p>Signed test identities only. Never use this issuer in production.</p>${["dev-member", "dev-owner", "dev-support", "dev-approver", "dev-approver-2"].map((u) => `<p><a href="/authorize?${query.toString()}&user=${u}">${u}</a></p>`).join("")}</body></html>`;
  });
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_r, body, done) =>
      done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );
  app.post("/token", async (r, reply) => {
    const b = r.body as any;
    const code = codes.get(b.code);
    codes.delete(b.code);
    const basic = r.headers.authorization
      ? Buffer.from(
          r.headers.authorization.replace("Basic ", ""),
          "base64",
        ).toString()
      : null;
    if (
      !code ||
      createHash("sha256")
        .update(b.code_verifier ?? "")
        .digest("base64url") !== code.code_challenge ||
      b.redirect_uri !== code.redirect_uri ||
      !(
        basic === "portcullis:development-secret" ||
        (b.client_id === "portcullis" &&
          b.client_secret === "development-secret")
      )
    )
      return reply.code(400).send({ error: "invalid_grant" });
    const m = code.mode;
    const groups =
      code.user === "dev-support"
        ? ["portal-support"]
        : code.user.startsWith("dev-approver")
          ? ["portal-approvers"]
          : [];
    const idToken = await new SignJWT({
      name: code.user,
      email: `${code.user}@example.invalid`,
      groups,
      nonce: m === "wrong-nonce" ? "wrong" : code.nonce,
      auth_time: Math.floor(Date.now() / 1000),
    })
      .setProtectedHeader({ alg: "RS256", kid: "development-key" })
      .setIssuer(m === "wrong-issuer" ? "http://evil.invalid" : issuer)
      .setSubject(code.user)
      .setAudience(m === "wrong-audience" ? "wrong" : "portcullis")
      .setIssuedAt()
      .setExpirationTime(
        m === "expired" ? Math.floor(Date.now() / 1000) - 120 : "5m",
      )
      .sign(m === "bad-signature" ? wrong.privateKey : keys.privateKey);
    return {
      access_token: "development-unused-token",
      token_type: "Bearer",
      expires_in: 300,
      id_token: idToken,
    };
  });
  await app.listen({ port, host: "127.0.0.1" });
  return {
    app,
    issuer,
    setMode: (m: string) => {
      mode = m;
    },
  };
}
if (
  process.argv[1]?.endsWith("dev-oidc.ts") ||
  process.argv[1]?.endsWith("dev-oidc.js")
) {
  await devIssuer();
  console.log("Signed development OIDC issuer on http://localhost:4100");
}
