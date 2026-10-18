import { afterEach, describe, expect, it, vi } from "vitest";
import { NetBirdClient } from "../src/providers/netbird.js";

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
