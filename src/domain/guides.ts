import { z } from "zod";
import type { Database } from "../db/index.js";
import type { Actor } from "./authorization.js";
import { can, requirePermission, hasServiceAccess } from "./authorization.js";
import { invariant } from "../errors.js";
import { hash, token } from "../security.js";
import { audit } from "./audit.js";
export class Guides {
  constructor(readonly db: Database) {}
  async visible(actor: Actor, g: any) {
    return (
      can(actor, "guides.manage", g.service_id ?? "*") ||
      (g.visibility === "members" &&
        (!g.service_id ||
          (await hasServiceAccess(this.db, actor.id, g.service_id))))
    );
  }
  async list(actor: Actor) {
    const rows = await this.db.query(
      "SELECT g.*,v.body FROM guides g JOIN guide_versions v ON v.guide_id=g.id AND v.version=g.current_version ORDER BY g.title",
    );
    const result = [];
    for (const g of rows)
      if (await this.visible(actor, g)) {
        const a = await this.db.query(
          "SELECT version,accepted_at FROM acknowledgments WHERE guide_id=$1 AND user_id=$2",
          [g.id, actor.id],
        );
        result.push({
          ...g,
          accepted: a,
          canManage: can(actor, "guides.manage", g.service_id ?? "*"),
        });
      }
    return result;
  }
  async get(actor: Actor, id: string) {
    const [g] = await this.db.query("SELECT * FROM guides WHERE id=$1", [id]);
    invariant(g && (await this.visible(actor, g)), "not_found", 404);
    return g;
  }
  async save(actor: Actor, input: unknown, id?: string) {
    const d = z
      .object({
        title: z.string().min(3).max(200),
        body: z.string().min(1).max(100000),
        visibility: z.enum(["members", "staff"]).default("members"),
        serviceId: z.uuid().nullable().default(null),
        required: z.boolean().default(false),
        version: z.number().int().optional(),
      })
      .strict()
      .parse(input);
    requirePermission(actor, "guides.manage", d.serviceId ?? "*");
    if (id) {
      const g = await this.get(actor, id);
      requirePermission(actor, "guides.manage", g.service_id ?? "*");
    }
    return this.db.transaction(async (tx) => {
      let g;
      if (id) {
        [g] = await tx.query(
          "UPDATE guides SET title=$1,visibility=$2,service_id=$3,required=$4,current_version=current_version+1 WHERE id=$5 AND current_version=$6 RETURNING *",
          [d.title, d.visibility, d.serviceId, d.required, id, d.version],
        );
        invariant(g, "version_conflict", 409);
      } else
        [g] = await tx.query(
          "INSERT INTO guides(title,visibility,service_id,required) VALUES ($1,$2,$3,$4) RETURNING *",
          [d.title, d.visibility, d.serviceId, d.required],
        );
      await tx.query(
        "INSERT INTO guide_versions(guide_id,version,body) VALUES ($1,$2,$3)",
        [g.id, g.current_version, d.body],
      );
      await audit(tx, actor.id, "guide.save", g.id, {
        version: g.current_version,
      });
      return g;
    });
  }
  async accept(actor: Actor, id: string, version: number) {
    const g = await this.get(actor, id);
    invariant(g.current_version === version, "document_version_changed", 409);
    await this.db.query(
      "INSERT INTO acknowledgments(user_id,guide_id,version) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
      [actor.id, id, version],
    );
    await audit(this.db, actor.id, "guide.acknowledge", id, { version });
  }
  async invite(actor: Actor, hours: number) {
    requirePermission(actor, "identity.manage");
    invariant(
      Number.isInteger(hours) && hours > 0 && hours <= 168,
      "invalid_expiry",
    );
    const secret = token();
    const [i] = await this.db.query(
      "INSERT INTO invitations(token_hash,created_by,expires_at) VALUES ($1,$2,now()+$3*interval '1 hour') RETURNING id,expires_at",
      [hash(secret), actor.id, hours],
    );
    await audit(this.db, actor.id, "invitation.create", i.id);
    return { ...i, invitation: secret };
  }
  async redeem(actor: Actor, secret: string) {
    const [i] = await this.db.query(
      "UPDATE invitations SET consumed_by=$1,consumed_at=now() WHERE token_hash=$2 AND expires_at>now() AND revoked_at IS NULL AND consumed_at IS NULL RETURNING id",
      [actor.id, hash(secret)],
    );
    invariant(i, "invitation_invalid", 400);
    await audit(this.db, actor.id, "invitation.redeem", i.id);
    return { ok: true, grantsIssued: false };
  }
  async onboarding(actor: Actor) {
    const guides = (await this.list(actor)).filter((g) => g.required);
    return {
      steps: await this.db.query(
        "SELECT step,completed_at FROM onboarding WHERE user_id=$1",
        [actor.id],
      ),
      guides,
      rulesNeedReview: guides.some(
        (g) => !g.accepted.some((a: any) => a.version === g.current_version),
      ),
      devicesLinked: !!(
        await this.db.query(
          "SELECT 1 FROM identity_links WHERE user_id=$1 AND provider='netbird'",
          [actor.id],
        )
      ).length,
    };
  }
  async complete(actor: Actor, step: string) {
    invariant(
      [
        "profile",
        "rules",
        "network-guidance",
        "devices",
        "browse",
        "service-setup",
      ].includes(step),
      "invalid_step",
    );
    if (step === "rules") {
      const guides = (await this.list(actor)).filter((g) => g.required);
      invariant(
        guides.every((g) =>
          g.accepted.some((a: any) => a.version === g.current_version),
        ),
        "rules_not_accepted",
      );
    }
    if (step === "devices")
      invariant(
        (
          await this.db.query("SELECT 1 FROM devices WHERE user_id=$1", [
            actor.id,
          ])
        ).length,
        "no_verified_devices",
      );
    await this.db.query(
      "INSERT INTO onboarding(user_id,step) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [actor.id, step],
    );
  }
}
