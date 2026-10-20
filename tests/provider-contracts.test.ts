import { afterEach, describe, expect, it, vi } from "vitest";
import { NetBirdClient } from "../src/providers/netbird.js";
import {
  WaygateClient,
  summarizeWaygateHealth,
} from "../src/providers/waygate.js";

afterEach(() => vi.unstubAllGlobals());

describe("NetBird response contracts", () => {
  it("normalizes only empty group collections, preserving populated entries", async () => {
    const groups = [
      { id: "empty", name: "Empty", peers: null, resources: null },
      { id: "legacy", name: "Legacy" },
      {
        id: "populated",
        name: "Populated",
        peers: [{ id: "peer-1", name: "Server" }],
        resources: [{ id: "resource-1", type: "host" }],
      },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(groups)));
    const result = await new NetBirdClient(
      "https://netbird.example",
      "test-token",
    ).groups();
    expect(result[0]).toMatchObject({ peers: [], resources: [] });
    expect(result[1]).toMatchObject({ peers: [], resources: [] });
    expect(result[2]).toEqual(groups[2]);
  });

  it("rejects malformed memberships with field paths but no response values or credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json([
          {
            id: "group",
            name: "Private group",
            peers: ["private-peer-id"],
            resources: null,
          },
        ]),
      ),
    );
    await expect(
      new NetBirdClient("https://netbird.example", "private-token").groups(),
    ).rejects.toMatchObject({
      code: "contract-mismatch",
      details: {
        method: "GET",
        path: "/api/groups",
        status: 200,
        reason: "invalid-response",
        fields: ["0.peers.0"],
      },
    });
  });

  it("distinguishes an HTML proxy page from a JSON schema mismatch", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response("<html>private proxy page</html>")),
    );
    await expect(
      new NetBirdClient("https://netbird.example", "private-token").users(),
    ).rejects.toMatchObject({
      code: "contract-mismatch",
      details: {
        method: "GET",
        path: "/api/users",
        status: 200,
        reason: "invalid-json",
      },
    });
  });
});

describe("Waygate Management API v1 response contracts", () => {
  const validToken = "0123456789abcdef0123456789abcdef";

  it("enforces bearer token format and rejects short or whitespace-containing tokens", async () => {
    await expect(
      new WaygateClient("https://waygate.example", "too-short").dashboard(),
    ).rejects.toMatchObject({
      code: "missing-credentials",
      provider: "wow-manager",
    });
    await expect(
      new WaygateClient(
        "https://waygate.example",
        "0123456789abcdef 0123456789abcdef",
      ).dashboard(),
    ).rejects.toMatchObject({
      code: "missing-credentials",
      provider: "wow-manager",
    });
  });

  it("parses complete and partial dashboard snapshots and maps health states accurately", async () => {
    const partialSnapshot = {
      generated_at: "2026-10-01T12:00:00.250Z",
      cache_ttl_seconds: 20,
      demo: false,
      partial: true,
      data: {
        status: {
          realm_name: "Icecrown",
          realm_up: true,
          core_name: "AzerothCore",
          expansion: "Wrath of the Lich King",
          world_version: "",
          public_host: "wow.example.com",
          public_auth_port: 3724,
          public_world_port: 8085,
          population: {
            humans: 5,
            bots: 10,
            gms: 1,
            total: 15,
            alliance: 3,
            horde: 2,
          },
        },
        players: null,
        leaderboards: {
          playtime: [],
          kills: [],
          honor: [],
          arena: [],
          gold: [],
        },
        modules: [{ id: "mod-eluna", title: "Eluna Lua Engine" }],
      },
      errors: [
        {
          section: "players",
          code: "players_unavailable",
          message: "Requested data could not be collected.",
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(Response.json(partialSnapshot));
    vi.stubGlobal("fetch", fetchMock);
    const client = new WaygateClient("https://waygate.example", validToken);
    const [first, second] = await Promise.all([
      client.dashboard(),
      client.dashboard(),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(summarizeWaygateHealth(first).state).toBe("degraded");
    expect(
      summarizeWaygateHealth({
        ...first,
        partial: false,
        errors: [],
        data: {
          ...first.data,
          status: { ...first.data.status!, realm_up: false },
          players: [],
        },
      }).state,
    ).toBe("down");
  });

  it("maps 401, 404, and 503 dedicated endpoint errors to normalized ProviderErrors", async () => {
    const client = new WaygateClient("https://waygate.example", validToken);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          {
            error: {
              code: "players_unavailable",
              message: "Requested data could not be collected.",
            },
          },
          { status: 503 },
        ),
      ),
    );
    await expect(client.players()).rejects.toMatchObject({
      code: "unavailable",
      provider: "wow-manager",
      retryable: true,
    });

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: { code: "not_found", message: "API disabled" } },
            { status: 404 },
          ),
        ),
    );
    await expect(client.status()).rejects.toMatchObject({
      code: "not-found",
      provider: "wow-manager",
      retryable: false,
    });
  });
});
