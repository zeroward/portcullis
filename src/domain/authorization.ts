import type { Queryable } from "../db/index.js";
import { invariant } from "../errors.js";
export type Role =
  | "member"
  | "support"
  | "approver"
  | "service-admin"
  | "network-admin"
  | "identity-admin"
  | "owner";
export interface Actor {
  id: string;
  name: string;
  email: string | null;
  timezone: string;
  roles: { role: Role; scope: string }[];
  csrf: string;
  sessionId: string;
  authenticatedAt: Date;
}
const rolePermissions: Record<Role, string[]> = {
  member: [
    "catalog.read",
    "ticket.own",
    "request.own",
    "devices.own",
    "guides.read",
  ],
  support: ["ticket.staff"],
  approver: ["access.decide"],
  "service-admin": [
    "catalog.manage",
    "access.manage",
    "monitor.manage",
    "guides.manage",
    "incident.manage",
  ],
  "network-admin": ["network.manage"],
  "identity-admin": ["identity.manage"],
  owner: ["*"],
};
export function can(actor: Actor, permission: string, scope = "*") {
  return actor.roles.some(
    (r) =>
      (r.scope === "*" || r.scope === scope) &&
      (rolePermissions[r.role].includes("*") ||
        rolePermissions[r.role].includes(permission)),
  );
}
export function requirePermission(
  actor: Actor,
  permission: string,
  scope = "*",
) {
  invariant(can(actor, permission, scope), "forbidden", 403);
}
export function requireFresh(
  actor: Actor,
  confirmation: string,
  expected: string,
) {
  invariant(
    Date.now() - actor.authenticatedAt.getTime() < 15 * 60 * 1000,
    "reauthentication_required",
    403,
  );
  invariant(confirmation === expected, "confirmation_required");
}
export async function invalidate(db: Queryable, user: string) {
  await db.query("UPDATE users SET auth_version=auth_version+1 WHERE id=$1", [
    user,
  ]);
  await db.query("DELETE FROM sessions WHERE user_id=$1", [user]);
}
export async function hasServiceAccess(
  db: Queryable,
  user: string,
  service: string,
) {
  const [target] = await db.query(
    "SELECT s.visibility,u.suspended FROM services s JOIN users u ON u.id=$1 WHERE s.id=$2",
    [user, service],
  );
  if (!target || target.suspended || target.visibility === "admin")
    return false;
  const rows = await db.query(
    `SELECT se.entitlement_id, EXISTS(SELECT 1 FROM grants g WHERE g.user_id=$1 AND g.entitlement_id=se.entitlement_id AND g.desired AND (g.expires_at IS NULL OR g.expires_at>now()) AND g.fulfillment='active') AS active FROM service_entitlements se WHERE se.service_id=$2`,
    [user, service],
  );
  if (target.visibility === "entitled" && !rows.length) return false;
  return rows.every((r) => r.active);
}
