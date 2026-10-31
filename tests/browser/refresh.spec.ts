import { test, expect, type Page } from "@playwright/test";

async function signIn(page: Page, user = "dev-owner") {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in with Pocket ID" }).click();
  await page.getByRole("link", { name: user, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Find your next adventure." }),
  ).toBeVisible();
}
async function navigate(page: Page, name: string) {
  if (await page.getByRole("button", { name: "Open navigation" }).isVisible())
    await page.getByRole("button", { name: "Open navigation" }).click();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name, exact: true })
    .click();
}
async function fits(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}
test("grouped navigation, theme persistence, history and mobile keyboard drawer", async ({
  page,
}) => {
  await signIn(page);
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await expect(nav.getByText("Play", { exact: true })).toBeVisible();
  await expect(
    nav.locator(".nav-label", { hasText: "Community" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Light theme", exact: true }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await navigate(page, "Guides");
  await navigate(page, "My access");
  await page.goBack();
  await expect(page).toHaveURL(/\/guides$/);
  await expect(
    nav.getByRole("button", { name: "Guides", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.goForward();
  await expect(page).toHaveURL(/\/access$/);
  await page.setViewportSize({ width: 390, height: 844 });
  const open = page.getByRole("button", { name: "Open navigation" });
  await open.focus();
  await page.keyboard.press("Enter");
  const drawer = page.getByRole("dialog", { name: "Navigation", exact: true });
  await expect(drawer).toBeVisible();
  for (let i = 0; i < 22; i++) {
    await page.keyboard.press("Tab");
    expect(
      await drawer.evaluate((el) => el.contains(document.activeElement)),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
  await expect(open).toBeFocused();
  await navigate(page, "Services");
  await expect(
    page.getByRole("heading", { name: "Find your next adventure." }),
  ).toBeVisible();
});

test("service draft dismissal, checkbox selections and hidden validation preserve payloads", async ({
  page,
}) => {
  await signIn(page);
  const add = page.getByRole("button", { name: "+ Add service", exact: true });
  await add.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("LAN draft");
  await dialog.getByLabel("Slug", { exact: true }).fill("lan-draft");
  page.once("dialog", (d) => d.dismiss());
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(
    "LAN draft",
  );
  page.once("dialog", (d) => d.accept());
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(add).toBeFocused();
  await add.click();
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(
    "LAN draft",
  );
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "How do members connect?" }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Add Endpoint", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog.getByLabel("Host", { exact: true })).toBeFocused();
  await dialog.getByLabel("Host", { exact: true }).fill("lan.example.invalid");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Each endpoint needs a host and at least one port",
  );
  await dialog.getByRole("button", { name: "Add Port", exact: true }).click();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "Who can discover and use it?" }),
  ).toBeVisible();
  await dialog
    .getByRole("searchbox", { name: "Search Required entitlements" })
    .fill("Realm player");
  const picker = dialog.getByRole("group", {
    name: "Required entitlements",
    exact: true,
  });
  await picker.getByRole("checkbox", { name: /Realm player/ }).check();
  await expect(picker).toContainText("1 selected");
  await picker.getByRole("button", { name: "Remove Realm player" }).click();
  await expect(
    picker.getByRole("checkbox", { name: /Realm player/ }),
  ).not.toBeChecked();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "Review before creating" }),
  ).toBeVisible();
  await page.route("**/api/service-setups", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 400,
          json: {
            error: "validation_failed",
            fields: ["service.metadata.endpoints.0.host"],
          },
        })
      : route.continue(),
  );
  await dialog
    .getByRole("button", { name: "Create service", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("validation failed");
  await expect(dialog.getByLabel("Host", { exact: true })).toBeFocused();
  await page.unroute("**/api/service-setups");
  await dialog
    .getByLabel("Host", { exact: true })
    .fill("lan-fixed.example.invalid");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await page.route("**/api/service-setups", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          json: {
            service: { id: "review-fixture", version: 1 },
            healthCheck: null,
          },
        })
      : route.continue(),
  );
  const write = page.waitForRequest(
    (r) => r.url().endsWith("/api/service-setups") && r.method() === "POST",
  );
  await dialog
    .getByRole("button", { name: "Create service", exact: true })
    .click();
  const body = (await write).postDataJSON();
  expect(body.service.metadata.endpoints[0].host).toBe(
    "lan-fixed.example.invalid",
  );
  expect(body.service.metadata.endpoints[0].ports).toEqual([443]);
  expect(body.service.entitlementIds).toEqual([]);
  expect(body.healthCheck).toBeNull();
  expect(body.service).not.toHaveProperty("group");
  await expect(dialog).toHaveCount(0);
  await add.click();
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("");
});

test("game setup offers only TCP or Pterodactyl monitoring", async ({
  page,
}) => {
  await page.route("**/api/service-setups/options", (route) =>
    route.fulfill({
      json: {
        gameMetadata: false,
        healthKinds: [
          { id: "http", available: true },
          { id: "tcp", available: true },
          { id: "manual", available: true },
          { id: "kuma", available: true },
          { id: "waygate", available: false, reason: "Not configured" },
          { id: "incoming", available: false, reason: "Not configured" },
          { id: "pterodactyl", available: true },
        ],
      },
    }),
  );
  await page.route("**/api/form-options/pterodactyl-servers", (route) =>
    route.fulfill({
      json: [
        {
          id: "1a7ce997",
          label: "Community Minecraft",
          description: "Gaming node",
        },
      ],
    }),
  );
  await signIn(page);
  await page
    .getByRole("button", { name: "+ Add service", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("Pterodactyl game");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    dialog.getByRole("combobox", { name: "Check type", exact: true }),
  ).toContainText("HTTP");
  await expect(
    dialog.getByRole("combobox", { name: "Check type", exact: true }),
  ).toContainText("Uptime Kuma");
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  await dialog.getByLabel("Type", { exact: true }).selectOption("game");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  const kinds = dialog.getByRole("combobox", {
    name: "Check type",
    exact: true,
  });
  await expect(kinds.locator("option")).toHaveText([
    "No monitoring",
    "TCP",
    "Pterodactyl",
  ]);
  await kinds.selectOption("pterodactyl");
  await dialog
    .getByLabel("Pterodactyl server", { exact: true })
    .selectOption("1a7ce997");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await page.route("**/api/service-setups", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          json: {
            service: { id: "pterodactyl-fixture", version: 1 },
            healthCheck: { id: "check-fixture" },
          },
        })
      : route.continue(),
  );
  const write = page.waitForRequest(
    (request) =>
      request.url().endsWith("/api/service-setups") &&
      request.method() === "POST",
  );
  await dialog
    .getByRole("button", { name: "Create service", exact: true })
    .click();
  expect((await write).postDataJSON().healthCheck).toEqual({
    kind: "pterodactyl",
    intervalSeconds: 60,
    config: {
      serverIdentifier: "1a7ce997",
      vantage: "Portcullis worker",
    },
  });
});

for (const width of [390, 768, 1440])
  for (const theme of ["dark", "light"]) {
    test(`visual review: ${width}px ${theme}, member and administrator`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.addInitScript(
        (theme) => localStorage.setItem("portcullis-theme", theme),
        theme,
      );
      await page.goto("/");
      await expect(
        page.getByRole("link", { name: "Sign in with Pocket ID" }),
      ).toBeVisible();
      await fits(page);
      await page.screenshot({
        path: info.outputPath("login.png"),
        fullPage: true,
      });
      await signIn(page, "dev-member");
      const contrasts = await page.evaluate(() => {
        const css = getComputedStyle(document.documentElement);
        const luminance = (token: string) => {
          const probe = document.createElement("span");
          probe.style.color = css.getPropertyValue(token).trim();
          document.body.append(probe);
          const rgb = getComputedStyle(probe)
            .color.match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number)
            .map((c) => c / 255)
            .map((c) =>
              c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
            );
          probe.remove();
          return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
        };
        const ratio = (a: string, b: string) => {
          const x = luminance(a),
            y = luminance(b);
          return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
        };
        return [
          "--text",
          "--muted",
          "--accent",
          "--success",
          "--danger",
          "--warning",
        ]
          .map((token) => ratio(token, "--panel"))
          .concat(ratio("--accent-ink", "--accent"));
      });
      for (const ratio of contrasts) expect(ratio).toBeGreaterThanOrEqual(4.5);
      await fits(page);
      await expect(
        page.getByRole("button", { name: "+ Add service" }),
      ).toHaveCount(0);
      await page.screenshot({
        path: info.outputPath("member-services.png"),
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "Community hub", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Connection details" }),
      ).toBeVisible();
      await fits(page);
      await page.screenshot({
        path: info.outputPath("service-details.png"),
        fullPage: false,
      });
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("button", { name: "Community hub", exact: true }),
      ).toBeFocused();
      for (const [name, heading] of [
        ["My access", "My access"],
        ["My devices", "My devices"],
        ["Support", "Community support"],
        ["Guides", "Community guides"],
        ["Get started", "Make yourself at home."],
        ["Community", "Community news & service notices"],
        ["Updates", "Your updates"],
      ]) {
        await navigate(page, name);
        await expect(
          page.getByRole("heading", { name: heading, exact: true, level: 1 }),
        ).toBeVisible();
        await fits(page);
      }
      if (width < 901)
        await page.getByRole("button", { name: "Open navigation" }).click();
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await expect(
        page.getByRole("link", { name: "Sign in with Pocket ID" }),
      ).toBeVisible();
      await signIn(page);
      await page.screenshot({
        path: info.outputPath("admin-services.png"),
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "+ Add service", exact: true })
        .click();
      await expect(page.getByLabel("Name", { exact: true })).toBeVisible();
      await fits(page);
      await page.screenshot({
        path: info.outputPath("service-editor.png"),
        fullPage: false,
      });
      await page.keyboard.press("Escape");
      await navigate(page, "Administration");
      await expect(page.locator(".overview-stats")).toBeVisible();
      await fits(page);
      await page.screenshot({
        path: info.outputPath("administration.png"),
        fullPage: true,
      });
      await page.getByRole("button", { name: "network", exact: true }).click();
      await expect(
        page.getByText("Gaming access", { exact: true }).first(),
      ).toBeVisible();
      await fits(page);
      await page.screenshot({
        path: info.outputPath("network.png"),
        fullPage: true,
      });
      expect(
        await page
          .locator("button")
          .first()
          .evaluate((el) => getComputedStyle(el).transitionDuration),
      ).toBe("0s");
    });
  }

test("support drafts survive dismissal and dirty history navigation can be cancelled", async ({
  page,
}) => {
  await signIn(page, "dev-member");
  await navigate(page, "Support");
  await page.getByRole("button", { name: "+ New ticket", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Subject", { exact: true })
    .fill("Retained support draft");
  await dialog
    .getByLabel("What happened?")
    .fill("Connection instructions need clarification.");
  const service = dialog.getByLabel("Related service (optional)", {
    exact: true,
  });
  await service.selectOption({ label: "Community hub" });
  const selectedService = await service.inputValue();
  page.once("dialog", (d) => d.dismiss());
  await page.goBack();
  await expect(page).toHaveURL(/\/tickets$/);
  await expect(dialog.getByLabel("Subject", { exact: true })).toHaveValue(
    "Retained support draft",
  );
  page.once("dialog", (d) => d.accept());
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "+ New ticket", exact: true }).click();
  await expect(dialog.getByLabel("Subject", { exact: true })).toHaveValue(
    "Retained support draft",
  );
  await expect(dialog.getByLabel("What happened?")).toHaveValue(
    "Connection instructions need clarification.",
  );
  await expect(service).toHaveValue(selectedService);
  const storage = await page.evaluate(() =>
    JSON.stringify({ ...localStorage, ...sessionStorage }),
  );
  expect(storage).not.toContain("Retained support draft");
});

test("discovery filters preserve artwork and long service content fits mobile", async ({
  page,
}) => {
  await page.route("**/api/services", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const rows = await response.json();
    const service = rows.find(
      (r: { name: string }) => r.name === "Community hub",
    );
    service.name = "Community hub " + "LongUnbrokenServiceName".repeat(8);
    service.summary = "A library for the community. ".repeat(8);
    service.cover = "/test-service-cover.svg";
    service.favorite = true;
    service.category = "Library";
    await route.fulfill({ json: rows });
  });
  await page.route("**/test-service-cover.svg", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#305c42"/></svg>',
    }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "dev-member");
  await page
    .getByLabel("Search services", { exact: true })
    .fill("Community hub");
  await expect(page.locator(".card")).toHaveCount(1);
  await expect(page.locator(".art")).toHaveCSS(
    "background-image",
    /test-service-cover.svg/,
  );
  await expect(page.locator(".art .emblem")).toHaveCount(0);
  await page.getByLabel("Category", { exact: true }).selectOption("Library");
  await page.getByRole("button", { name: "Favorites", exact: true }).click();
  await expect(page.locator(".card")).toHaveCount(1);
  await fits(page);
  await page.locator(".card h2 button").click();
  await fits(page);
  await page.keyboard.press("Escape");
  await page
    .getByLabel("Search services", { exact: true })
    .fill("no-such-service");
  await expect(
    page.getByText("No services match your selection."),
  ).toBeVisible();
});
