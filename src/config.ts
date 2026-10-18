import { z } from "zod";

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  RATE_LIMIT_MAX: z.coerce.number().int().min(20).max(5000).default(120),
  BASE_URL: z.url().default("http://localhost:3000"),
  DATABASE_URL: z
    .string()
    .default("postgres://portcullis:development@127.0.0.1:5432/portcullis"),
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i),
  OIDC_ISSUER: z.url(),
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().min(1),
  OWNER_SUBJECT: z.string().default(""),
  ROLE_GROUP_MAPPINGS: z.string().default("{}"),
  POCKET_ID_URL: z.url().optional(),
  POCKET_ID_API_KEY: z.string().optional(),
  POCKET_ID_VERSION: z.string().default("unverified"),
  NETBIRD_URL: z.url().optional(),
  NETBIRD_TOKEN: z.string().optional(),
  NETBIRD_VERSION: z.string().default("unverified"),
  NETBIRD_MANAGEMENT_URL: z.url().default("https://netbird.example.invalid"),
  CAPABILITY_OVERRIDES: z.string().default("{}"),
  TRUSTED_PROXIES: z.string().default(""),
  UPLOAD_DIR: z.string().default("./uploads"),
  MONITOR_ALLOWED_CIDRS: z.string().default(""),
  MONITOR_ALLOWED_DOMAINS: z.string().default(""),
  MONITOR_ALLOWED_PORTS: z.string().default("80,443"),
  HEALTH_WEBHOOK_KEY: z.string().min(32).optional(),
  SMTP_URL: z.string().optional(),
  SMTP_FROM: z.string().default("portal@example.invalid"),
  DISCORD_WEBHOOK_URL: z.url().optional(),
  OUTGOING_WEBHOOK_URL: z.url().optional(),
  OUTGOING_WEBHOOK_KEY: z.string().min(32).optional(),
  ENABLE_MOCK_PROVIDERS: z.enum(["true", "false"]).default("false"),
  TIMEZONE: z.string().default("America/Chicago"),
});
export type Config = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const c = schema.parse(env);
  const origin = new URL(c.BASE_URL);
  if (origin.pathname !== "/" || origin.search || origin.hash)
    throw new Error("BASE_URL must be an origin");
  if (c.NODE_ENV === "production") {
    if (
      origin.protocol !== "https:" ||
      new URL(c.OIDC_ISSUER).protocol !== "https:"
    )
      throw new Error("Production requires HTTPS");
    if (
      c.ENABLE_MOCK_PROVIDERS === "true" ||
      /localhost|127\.0\.0\.1/.test(c.OIDC_ISSUER)
    )
      throw new Error("Development providers forbidden in production");
    if (/^(0{64}|1{64})$/.test(c.ENCRYPTION_KEY))
      throw new Error("Production encryption key must be unique");
  }
  new Intl.DateTimeFormat("en", { timeZone: c.TIMEZONE });
  z.record(
    z.string(),
    z.array(
      z.enum([
        "member",
        "support",
        "approver",
        "service-admin",
        "network-admin",
        "identity-admin",
        "owner",
      ]),
    ),
  ).parse(JSON.parse(c.ROLE_GROUP_MAPPINGS));
  z.record(z.string(), z.boolean()).parse(JSON.parse(c.CAPABILITY_OVERRIDES));
  for (const url of [
    c.POCKET_ID_URL,
    c.NETBIRD_URL,
    c.DISCORD_WEBHOOK_URL,
    c.OUTGOING_WEBHOOK_URL,
  ]) {
    if (
      url &&
      (new URL(url).username ||
        new URL(url).password ||
        (c.NODE_ENV === "production" && new URL(url).protocol !== "https:"))
    )
      throw new Error("Invalid integration destination");
  }
  return c;
}
