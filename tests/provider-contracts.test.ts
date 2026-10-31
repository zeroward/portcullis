import { afterEach, describe, expect, it, vi } from "vitest";
import { NetBirdClient } from "../src/providers/netbird.js";
import {
  WaygateClient,
  summarizeWaygateHealth,
} from "../src/providers/waygate.js";
import { RawgClient } from "../src/providers/rawg.js";
import {
  PterodactylClient,
  summarizePterodactylHealth,
} from "../src/providers/pterodactyl.js";

afterEach(() => vi.unstubAllGlobals());

describe("Pterodactyl Client API contracts", () => {
  it("lists accessible servers, follows pagination, and reads power state", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init: any) => {
      expect(init.headers.Authorization).toBe("Bearer test-pterodactyl-token");
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/resources"))
        return Promise.resolve(
          Response.json({
            object: "stats",
            attributes: {
              current_state: "running",
              is_suspended: false,
              resources: { memory_bytes: 123 },
            },
          }),
        );
      const page = Number(parsed.searchParams.get("page"));
      return Promise.resolve(
        Response.json({
          object: "list",
          data: [
            {
              object: "server",
              attributes: {
                identifier: `server-${page}`,
                name: `Server ${page}`,
                node: "Node",
              },
            },
          ],
          meta: { pagination: { current_page: page, total_pages: 2 } },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new PterodactylClient(
      "https://panel.example",
      "test-pterodactyl-token",
    );
    await expect(client.servers()).resolves.toHaveLength(2);
    const snapshot = await client.resources("server-1");
    expect(snapshot.attributes).toEqual({
      current_state: "running",
      is_suspended: false,
    });
    expect(summarizePterodactylHealth(snapshot)).toEqual({
      state: "healthy",
      detail: { powerState: "running", suspended: false },
    });
  });

  it("maps lifecycle states and rejects malformed provider responses", async () => {
    for (const [powerState, suspended, state] of [
      ["starting", false, "degraded"],
      ["stopping", false, "degraded"],
      ["offline", false, "down"],
      ["running", true, "down"],
      ["future-state", false, "unknown"],
    ] as const)
      expect(
        summarizePterodactylHealth({
          object: "stats",
          attributes: {
            current_state: powerState,
            is_suspended: suspended,
          },
        }).state,
      ).toBe(state);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ object: "stats" })),
    );
    await expect(
      new PterodactylClient(
        "https://panel.example",
        "test-pterodactyl-token",
      ).resources("server"),
    ).rejects.toMatchObject({
      code: "contract-mismatch",
      provider: "pterodactyl",
      details: { reason: "invalid-response" },
    });
  });
});

describe("RAWG game metadata contracts", () => {
  it("searches games and imports bounded artwork and descriptive metadata", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const path = new URL(url).pathname;
      if (path === "/api/games")
        return Promise.resolve(
          Response.json({
            results: [
              {
                id: 3498,
                name: "Grand Theft Auto V",
                released: "2013-09-17",
                background_image: "https://images.example/game.jpg",
                platforms: [{ platform: { name: "PC" } }],
              },
            ],
          }),
        );
      if (path.endsWith("/screenshots"))
        return Promise.resolve(
          Response.json({
            results: [{ image: "https://images.example/screenshot.jpg" }],
          }),
        );
      return Promise.resolve(
        Response.json({
          id: 3498,
          slug: "grand-theft-auto-v",
          name: "Grand Theft Auto V",
          description_raw: "A sprawling open-world game.",
          background_image: "https://images.example/game.jpg",
          website: "https://game.example",
          genres: [{ name: "Action" }],
          tags: [{ name: "Open World" }],
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new RawgClient("test-key");
    await expect(client.search("Grand Theft Auto")).resolves.toEqual([
      {
        id: "3498",
        name: "Grand Theft Auto V",
        released: "2013-09-17",
        image: "https://images.example/game.jpg",
        platforms: ["PC"],
      },
    ]);
    await expect(client.game("3498")).resolves.toMatchObject({
      name: "Grand Theft Auto V",
      description: "A sprawling open-world game.",
      category: "Action",
      tags: ["Action", "Open World"],
      screenshots: ["https://images.example/screenshot.jpg"],
      source: {
        provider: "rawg",
        url: "https://rawg.io/games/grand-theft-auto-v",
      },
    });
    expect(
      fetchMock.mock.calls.every(([url]) => `${url}`.includes("key=test-key")),
    ).toBe(true);
  });

  it("rejects malformed provider responses without returning their values", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(Response.json({ results: [{ id: "private" }] })),
    );
    await expect(
      new RawgClient("test-key").search("game"),
    ).rejects.toMatchObject({
      code: "contract-mismatch",
      provider: "rawg",
      details: { reason: "invalid-response", fields: expect.any(Array) },
    });
  });
});

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
