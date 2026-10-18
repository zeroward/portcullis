import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import {
  defaults,
  fieldsFor,
  payload,
  serviceFields,
  validate,
} from "../web/forms/schema.js";
import { serviceInput } from "../src/domain/catalog.js";
import { entitlementInput } from "../src/domain/access.js";
import { checkInput } from "../src/monitoring.js";
const id = "00000000-0000-4000-8000-000000000001";
describe("structured form payloads", () => {
  it("preserves full service metadata, relationships and concurrency version", () => {
    const existing = serviceInput.parse({
      name: "Realm",
      slug: "realm",
      summary: "",
      visibility: "entitled",
      metadata: {
        type: "game",
        provider: "wow-manager",
        owner: "Ops",
        version: "1.2",
        environment: "Community",
        icon: "https://example.com/icon.png",
        cover: "https://example.com/cover.png",
        screenshots: ["https://example.com/game.png"],
        tags: ["games"],
        description: "**Welcome**",
        instructions: "Connect",
        rules: "Be kind",
        requiredClient: "Classic",
        endpoints: [
          {
            label: "Realm",
            host: "realm.example.com",
            protocol: "tcp",
            ports: [3724, 8085],
            network: "netbird",
            launch: "https://realm.example.com",
          },
        ],
        links: [
          { label: "Manage", url: "https://example.com/manage", admin: true },
        ],
      },
      entitlementIds: [id],
      dependencies: [{ id, required: false }],
      version: 7,
    });
    const edited = defaults(serviceFields, existing);
    edited.summary = "Updated";
    expect(serviceInput.parse(payload(serviceFields, edited))).toEqual({
      ...existing,
      summary: "Updated",
    });
  });
  it("round trips complete access policy including hidden/unavailable references", () => {
    const fields = fieldsFor("/api/entitlements/" + id);
    const existing = entitlementInput.parse({
      key: "game.realm",
      name: "Realm",
      policy: {
        description: "Read this",
        requestable: true,
        approvals: 3,
        noSelfApproval: true,
        maxHours: 100,
        defaultHours: 50,
        requiredGuides: [id],
        renewable: false,
      },
      prerequisites: [id],
      version: 12,
    });
    expect(
      entitlementInput.parse(payload(fields, defaults(fields, existing))),
    ).toEqual(existing);
    expect(
      validate({
        ...existing,
        policy: { ...existing.policy, defaultHours: 101 },
      }),
    ).toMatch(/maximum/);
  });
  it("omits incompatible monitoring settings after changing check type", () => {
    const fields = fieldsFor("/api/health/checks");
    const values = defaults(fields, {
      serviceId: id,
      kind: "tcp",
      config: {
        url: "https://example.com",
        host: "192.168.10.5",
        port: 443,
        secretReference: id,
      },
    });
    const saved = checkInput.parse(payload(fields, values));
    expect(saved.config.host).toBe("192.168.10.5");
    expect(saved.config.port).toBe(443);
    expect(saved.config.url).toBeUndefined();
    expect(saved.config.secretReference).toBeUndefined();
  });
  it("serializes provider-specific bindings without leaking stale external IDs", () => {
    const fields = fieldsFor("/api/admin/bindings");
    const values = defaults(fields, {
      entitlementId: id,
      provider: "manual",
      externalId: "old-provider-group",
      configuration: { instructions: "Set up account" },
      confirmation: "MANAGE",
    });
    expect(payload(fields, values)).toEqual({
      entitlementId: id,
      provider: "manual",
      configuration: { instructions: "Set up account" },
      confirmation: "MANAGE",
    });
  });
  it("normalizes optional fields and local dates without changing IDs", () => {
    const fields = fieldsFor("/api/maintenance");
    const result = payload(
      fields,
      defaults(fields, {
        title: "Maintenance",
        serviceId: "",
        startsAt: "2026-10-17T10:00",
        endsAt: "2026-10-17T11:00",
      }),
    );
    expect(result.serviceId).toBeNull();
    expect(result.startsAt).toBe(new Date("2026-10-17T10:00").toISOString());
    expect(validate({ ...result, endsAt: result.startsAt })).toMatch(
      /after start/,
    );
    expect(
      validate({
        roles: [
          { role: "support", scope: id },
          { role: "support", scope: id },
        ],
      }),
    ).toMatch(/once/);
  });
  it("has no remaining JSON editor or raw resource-ID input", async () => {
    const source = await readFile(
      new URL("../web/main.tsx", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /JsonAction|JSON\.parse|Configuration \(JSON\)|Dependencies \(JSON|label="[^"]*(?:user ID|service ID|job ID)/i,
    );
  });
});
