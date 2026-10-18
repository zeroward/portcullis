import { Database } from "../src/db/index.js";
export async function seed(db: Database, environment: string) {
  if (environment === "production")
    throw new Error("Development seed forbidden in production");
  await db.transaction(async (tx) => {
    const [owner] = await tx.query(
      "INSERT INTO users(issuer,subject,name,email,identity_checked_at) VALUES ('http://localhost:4100','dev-owner','Morgan (development)','morgan@example.invalid',now()) ON CONFLICT(issuer,subject) DO UPDATE SET name=EXCLUDED.name RETURNING id",
    );
    await tx.query(
      "INSERT INTO roles(user_id,role) VALUES ($1,'owner'),($1,'member') ON CONFLICT DO NOTHING",
      [owner.id],
    );
    await tx.query(
      "INSERT INTO users(issuer,subject,name,email,identity_checked_at) VALUES ('http://localhost:4100','dev-member','Alex (development)','alex@example.invalid',now()) ON CONFLICT DO NOTHING",
    );
    const [wow] = await tx.query(
      `INSERT INTO services(slug,name,summary,visibility,metadata) VALUES ('wow','World of Warcraft','A private world for the community. Development example.','discoverable',$1) ON CONFLICT(slug) DO UPDATE SET slug=EXCLUDED.slug RETURNING id`,
      [
        JSON.stringify({
          type: "game",
          category: "MMORPG",
          tags: ["Community", "PC"],
          description:
            "## Welcome to the realm\nAsk for access, then follow the setup guide. Game-account provisioning awaits the manager API specification.",
          provider: "wow-manager",
          version: "Operator configured",
          environment: "Development",
          endpoints: [
            {
              label: "Realm",
              host: "realm.example.invalid",
              protocol: "tcp",
              ports: [3724],
              network: "netbird",
            },
          ],
          links: [],
          instructions:
            "Use the realm address above in your client. Ask staff to attest manual game-account setup.",
          sortOrder: 1,
        }),
      ],
    );
    const [e] = await tx.query(
      `INSERT INTO entitlements(key,name,policy) VALUES ('game.wow.player','Realm player',$1) ON CONFLICT(key) DO UPDATE SET key=EXCLUDED.key RETURNING id`,
      [
        JSON.stringify({
          requestable: true,
          approvals: 1,
          noSelfApproval: true,
          maxHours: 720,
          defaultHours: 168,
          description: "Realm access with manual account setup",
        }),
      ],
    );
    await tx.query(
      "INSERT INTO service_entitlements VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [wow.id, e.id],
    );
    if (
      !(
        await tx.query("SELECT id FROM bindings WHERE entitlement_id=$1", [
          e.id,
        ])
      ).length
    )
      await tx.query(
        "INSERT INTO bindings(entitlement_id,provider,configuration,managed) VALUES ($1,'wow-manager','{}',true)",
        [e.id],
      );
    await tx.query(
      `INSERT INTO services(slug,name,summary,visibility,metadata) VALUES ('community','Community hub','Guides, links and a place to gather. Development example.','discoverable',$1) ON CONFLICT DO NOTHING`,
      [
        JSON.stringify({
          type: "service",
          category: "Community",
          tags: ["Web"],
          description:
            "## A shared starting point\nFind community news and setup help.",
          provider: "manual",
          endpoints: [],
          links: [
            {
              label: "Example website",
              url: "https://example.invalid",
              admin: false,
            },
          ],
          instructions: "Contact support if you need help.",
          sortOrder: 2,
        }),
      ],
    );
    if (!(await tx.query("SELECT id FROM guides")).length) {
      const [g] = await tx.query(
        "INSERT INTO guides(title,required) VALUES ('Community rules / development',true) RETURNING id",
      );
      await tx.query(
        "INSERT INTO guide_versions(guide_id,version,body) VALUES ($1,1,$2)",
        [
          g.id,
          "# Community rules\nBe kind. Keep credentials private. Respect the approved network scope. Acknowledgment records acceptance; it does not prove reading.",
        ],
      );
    }
  });
}
if (
  process.argv[1]?.endsWith("seed.ts") ||
  process.argv[1]?.endsWith("seed.js")
) {
  const db = new Database(process.env.DATABASE_URL!);
  try {
    await seed(db, process.env.NODE_ENV ?? "development");
    console.log("Fictional development data loaded");
  } finally {
    await db.close();
  }
}
