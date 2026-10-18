import type { Database } from "../db/index.js";
import type { Config } from "../config.js";
import type { NetBirdClient } from "../providers/netbird.js";
import { requirePermission, type Actor } from "./authorization.js";
import { invariant } from "../errors.js";
import { audit } from "./audit.js";
import { Tickets } from "./tickets.js";
import { Catalog } from "./catalog.js";
export class Devices {
  constructor(
    readonly db: Database,
    readonly config: Config,
    readonly netbird?: NetBirdClient,
  ) {}
  async sync() {
    if (!this.netbird) return;
    const links = await this.db.query(
      "SELECT user_id,external_id FROM identity_links WHERE provider='netbird'",
    );
    const peers = await this.netbird.peers();
    // Persist only peers with explicitly verified owners. Missing peers become unknown via observation age.
    for (const p of peers) {
      const link = links.find((l) => l.external_id === p.user_id);
      if (!link) continue;
      const metadata = {
        name: p.name,
        address: p.ip,
        os: p.os ?? null,
        reportedState:
          p.connected === undefined
            ? "unknown"
            : p.connected
              ? "online"
              : "offline",
        lastSeen: p.last_seen ?? null,
        groups: p.groups ?? [],
        handshake: null,
        latency: null,
        publicEndpoint: null,
        connectionType: null,
      };
      await this.db.query(
        "INSERT INTO devices(user_id,external_id,metadata) VALUES ($1,$2,$3) ON CONFLICT(external_id) DO UPDATE SET user_id=EXCLUDED.user_id,metadata=EXCLUDED.metadata,observed_at=now()",
        [link.user_id, p.id, JSON.stringify(metadata)],
      );
    }
  }
  async mine(actor: Actor) {
    const [link] = await this.db.query(
      "SELECT external_id,verified_at FROM identity_links WHERE user_id=$1 AND provider='netbird'",
      [actor.id],
    );
    const devices = await this.db.query(
      "SELECT * FROM devices WHERE user_id=$1 ORDER BY observed_at DESC",
      [actor.id],
    );
    return {
      linked: !!link,
      services: (await new Catalog(this.db).cards(actor))
        .filter((s) => s.access === "active")
        .map((s) => ({ id: s.id, name: s.name, health: s.health })),
      networkSteps: await this.db.query(
        `SELECT e.name AS entitlement,s.status,s.error
        FROM fulfillment_steps s JOIN grants g ON g.id=s.grant_id
        JOIN entitlements e ON e.id=g.entitlement_id JOIN bindings b ON b.id=s.binding_id
        WHERE g.user_id=$1 AND b.provider='netbird' AND g.desired
        AND (g.expires_at IS NULL OR g.expires_at>now())`,
        [actor.id],
      ),
      devices: devices.map((d) => ({
        ...d,
        metadata: {
          ...d.metadata,
          reportedState:
            Date.now() - new Date(d.observed_at).getTime() > 300000
              ? "unknown"
              : d.metadata.reportedState,
        },
      })),
      managementUrl: this.config.NETBIRD_MANAGEMENT_URL,
      verification:
        "Peer reports do not identify this browser or prove service connectivity.",
      guidance: {
        windows:
          "Install the official NetBird client, then sign in using your community account.",
        macos: "Install the official NetBird app, then sign in.",
        linux: `Install the official NetBird client, then run: netbird up --management-url ${this.config.NETBIRD_MANAGEMENT_URL}`,
      },
    };
  }
  async lost(actor: Actor, id: string, tickets: Tickets) {
    const [d] = await this.db.query(
      "SELECT * FROM devices WHERE id=$1 AND user_id=$2",
      [id, actor.id],
    );
    invariant(d, "not_found", 404);
    await this.db.query("UPDATE devices SET lost_at=now() WHERE id=$1", [id]);
    await audit(this.db, actor.id, "device.lost", id);
    return tickets.create(actor, {
      subject: `Lost device: ${d.metadata.name}`,
      description: "Please remove this device and review its network access.",
      type: "account problem",
    });
  }
  async remove(actor: Actor, id: string) {
    requirePermission(actor, "network.manage");
    invariant(this.netbird, "provider_not_configured", 503);
    const [d] = await this.db.query("SELECT * FROM devices WHERE id=$1", [id]);
    invariant(d, "not_found", 404);
    await this.netbird.removePeer(d.external_id);
    invariant(
      !(await this.netbird.peers()).some((p) => p.id === d.external_id),
      "peer_removal_unverified",
      502,
    );
    await this.db.query("DELETE FROM devices WHERE id=$1", [id]);
    await audit(
      this.db,
      actor.id,
      "device.remove",
      id,
      { controlPlaneVerified: true, trafficVerified: false },
      d.user_id,
    );
  }
}
