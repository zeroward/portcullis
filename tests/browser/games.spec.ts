import { test, expect, type Page } from "@playwright/test";
async function login(page: Page, user = "dev-owner") {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in with Pocket ID" }).click();
  await page.getByRole("link", { name: user, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your next adventure." }),
  ).toBeVisible();
}
test("game deletion protects populated games and removes an empty game after confirmation", async ({
  page,
}) => {
  await login(page);
  const { csrf } = await (await page.request.get("/api/me")).json();
  const headers = { "x-csrf-token": csrf, origin: "http://localhost:3000" };
  const create = async (name: string) => {
    const result = await page.request.post("/api/game-setups", {
      headers,
      data: {
        submissionId: crypto.randomUUID(),
        games: [{ key: "game", presentation: { name } }],
        servers: [
          {
            gameKey: "game",
            name: `${name} server`,
            connection: { host: "play.example.com", port: 25565 },
            visibility: "discoverable",
          },
        ],
      },
    });
    expect(result.ok()).toBe(true);
    const { gameIds } = await result.json();
    return (await page.request.get(`/api/games/${gameIds[0]}`)).json();
  };
  const game = await create("Delete browser game");
  const target = await create("Keep browser game");
  await page.reload();
  await page
    .locator(".game-open")
    .filter({ hasText: "Delete browser game" })
    .click();
  await page.getByRole("button", { name: "Edit game", exact: true }).click();
  await page.getByRole("button", { name: "Delete game…", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "still contains 1 server entry",
  );
  await page.getByRole("button", { name: "Back to game" }).click();
  expect(
    (
      await page.request.put(`/api/game-servers/${game.servers[0].id}/game`, {
        headers,
        data: { gameId: target.id },
      })
    ).ok(),
  ).toBe(true);
  await page.reload();
  await page
    .locator(".game-open")
    .filter({ hasText: "Delete browser game" })
    .click();
  await page.getByRole("button", { name: "Edit game", exact: true }).click();
  await page.getByRole("button", { name: "Delete game…", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Delete game", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Type DELETE to confirm").fill("DELETE");
  await page.getByRole("button", { name: "Delete game", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Your next adventure." }),
  ).toBeVisible();
  await expect(
    page.locator(".game-open").filter({ hasText: "Delete browser game" }),
  ).toHaveCount(0);
  expect(
    (await page.request.get(`/api/services/${game.servers[0].id}`)).ok(),
  ).toBe(true);
});
test("manual setup retains draft, requires access, publishes and copies a complete IPv6 address", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await login(page);
  await page.getByRole("button", { name: "+ Add game", exact: true }).click();
  await page.getByRole("button", { name: /Add manually/ }).click();
  await page
    .getByLabel("Game title", { exact: true })
    .fill("Browser manual game");
  await page.getByLabel("Short description").fill("A world built together.");
  await page
    .getByRole("button", { name: "Save draft and return", exact: false })
    .click();
  await page.getByRole("button", { name: "Resume setup" }).click();
  await expect(page.getByLabel("Game title", { exact: true })).toHaveValue(
    "Browser manual game",
  );
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByLabel("Server nickname").fill("Creative world");
  await page.getByLabel("Hostname or IP").fill("2001:db8::10");
  await page.getByRole("button", { name: "Review before publishing" }).click();
  await expect(page.getByLabel("Shared access choice")).toBeFocused();
  await page.getByLabel("Shared access choice").selectOption("everyone");
  await page.getByRole("button", { name: "Review before publishing" }).click();
  await page.getByRole("button", { name: "Publish 1 server" }).click();
  await expect(
    page.getByRole("heading", { name: "Browser manual game", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Copy address" }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("[2001:db8::10]:25565");
  expect(errors.filter((e) => e.includes("regular expression"))).toEqual([]);
});
test("Pterodactyl import confirms RAWG presentation and preserves access overrides", async ({
  page,
}) => {
  await page.route("**/api/game-imports", (r) =>
    r.fulfill({
      json: [
        {
          identifier: "1a7ce997",
          name: "Community Minecraft",
          allocations: [
            {
              id: 1,
              ip: "192.168.10.5",
              ip_alias: "play.example.com",
              port: 25565,
              is_default: true,
            },
          ],
        },
        {
          identifier: "already",
          name: "Already imported",
          imported: "existing",
          allocations: [],
        },
      ],
    }),
  );
  await page.route("**/api/game-metadata/search?*", (r) =>
    r.fulfill({ json: [{ id: "1", name: "Minecraft", platforms: ["PC"] }] }),
  );
  await page.route("**/api/game-metadata/1", (r) =>
    r.fulfill({
      json: {
        name: "Minecraft",
        summary: "Build something together.",
        description: "A shared sandbox.",
        category: "Sandbox",
        tags: [],
        screenshots: [],
        source: { provider: "rawg", url: "https://rawg.io/games/minecraft" },
      },
    }),
  );
  await login(page);
  await page.getByRole("button", { name: "+ Add game", exact: true }).click();
  await page.getByRole("button", { name: /Import from Pterodactyl/ }).click();
  await expect(
    page.getByLabel("Already imported", { exact: false }),
  ).toBeDisabled();
  await page.getByLabel("Community Minecraft", { exact: false }).check();
  await page.getByRole("button", { name: "Continue with 1 servers" }).click();
  await page
    .getByText("Look up game artwork and description", { exact: true })
    .click();
  await page.getByRole("button", { name: "Search games", exact: true }).click();
  await page.getByRole("button", { name: "Use metadata", exact: true }).click();
  await expect(page.getByLabel("Game title", { exact: true })).toHaveValue(
    "Minecraft",
  );
  await page
    .getByLabel("Game title", { exact: true })
    .fill("Imported Minecraft");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByLabel("Hostname or IP")).toHaveValue(
    "play.example.com",
  );
  await expect(page.getByLabel("Hostname or IP")).toBeDisabled();
  await page.getByLabel("Use a different address for players").check();
  await page.getByLabel("Hostname or IP").fill("join.example.com");
  await page.getByLabel("Shared access choice").selectOption("everyone");
  await page
    .getByRole("combobox", { name: "Access", exact: true })
    .selectOption("admin");
  await page.getByRole("button", { name: "Review before publishing" }).click();
  await expect(page.getByText("Access: Admins only")).toBeVisible();
  await page.getByRole("button", { name: "Publish 1 server" }).click();
  await expect(
    page.getByRole("heading", { name: "Imported Minecraft", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("join.example.com:25565", { exact: true }),
  ).toBeVisible();
});
test("library filters and detail pages fit mobile and desktop in both themes", async ({
  page,
}) => {
  await login(page);
  await page.route("**/api/games", async (r) => {
    const response = await r.fetch();
    const games = await response.json();
    games[0].name = "LongUnbrokenGameTitle".repeat(5);
    games[0].summary = "A place to play together.";
    games[0].cover = "/game-test-art.svg";
    games[0].favorite = true;
    await r.fulfill({ json: games });
  });
  await page.route("**/game-test-art.svg", (r) =>
    r.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect fill="#285554" width="800" height="450"/><circle fill="#bf9359" cx="500" cy="190" r="110"/></svg>',
    }),
  );
  await page.reload();
  await page.getByLabel("Search games and servers").fill("LongUnbroken");
  await expect(page.locator(".game-tile")).toHaveCount(1);
  await page.getByRole("button", { name: "Favorites", exact: true }).click();
  await page.screenshot({
    path: "test-results/games-desktop-dark.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Light theme", exact: true }).click();
  await page.screenshot({
    path: "test-results/games-desktop-light.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/games-mobile-light.png",
    fullPage: true,
  });
  await page.locator(".game-open").click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/game-detail-mobile.png",
    fullPage: true,
  });
});
test("services is a TODO tab and inaccessible imports preserve the setup", async ({
  page,
}) => {
  await login(page);
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Services", exact: true })
    .click();
  await expect(page.getByText(/TODO · A dedicated services/)).toBeVisible();
  await expect(page).toHaveURL(/\/services$/);
  await page.reload();
  await expect(page.getByText(/TODO · A dedicated services/)).toBeVisible();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Games", exact: true })
    .click();
  await page.route("**/api/game-imports", (r) =>
    r.fulfill({ status: 503, json: { error: "provider_not_configured" } }),
  );
  await page.getByRole("button", { name: "+ Add game", exact: true }).click();
  await page.getByRole("button", { name: /Import from Pterodactyl/ }).click();
  await expect(page.getByRole("alert")).toContainText(
    "provider not configured",
  );
  await expect(
    page.getByRole("button", { name: /Add manually/ }),
  ).toBeVisible();
});
