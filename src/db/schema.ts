import {
  pgTable,
  text,
  uuid,
  timestamp,
  integer,
  jsonb,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";
export const users = pgTable(
  "users",
  {
    id: uuid().primaryKey().defaultRandom(),
    issuer: text().notNull(),
    subject: text().notNull(),
    name: text().notNull(),
    email: text(),
    suspended: boolean().notNull().default(false),
    authVersion: integer("auth_version").notNull().default(1),
    timezone: text().notNull().default("America/Chicago"),
    identityCheckedAt: timestamp("identity_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [uniqueIndex("users_identity").on(t.issuer, t.subject)],
);
export const services = pgTable("services", {
  id: uuid().primaryKey().defaultRandom(),
  slug: text().notNull().unique(),
  name: text().notNull(),
  summary: text().notNull(),
  visibility: text().notNull(),
  metadata: jsonb().notNull(),
  version: integer().notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});
export const entitlements = pgTable("entitlements", {
  id: uuid().primaryKey().defaultRandom(),
  key: text().notNull().unique(),
  name: text().notNull(),
  policy: jsonb().notNull(),
  version: integer().notNull().default(1),
});
export const grants = pgTable("grants", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  entitlementId: uuid("entitlement_id")
    .notNull()
    .references(() => entitlements.id),
  source: text().notNull(),
  desired: boolean().notNull().default(true),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  fulfillment: text().notNull().default("queued"),
  version: integer().notNull().default(1),
  snapshot: jsonb().notNull(),
});
