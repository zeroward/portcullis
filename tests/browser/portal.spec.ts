import { test, expect, type Page } from "@playwright/test";
async function signIn(page: Page, user = "dev-member") {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in with Pocket ID" }).click();
  await page.getByRole("link", { name: user, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Find your next adventure." }),
  ).toBeVisible();
}
test("member request → admin approval → real provider fulfillment and owned devices", async ({
  browser,
  page,
}) => {
  await signIn(page);
  await page.getByRole("button", { name: "My access", exact: true }).click();
  await page
    .locator(".panel")
    .filter({
      has: page.getByRole("heading", { name: "Gaming network", exact: true }),
    })
    .getByRole("button", { name: "Request access" })
    .click();
  await page
    .getByLabel("Why would you like access?")
    .fill("Please connect my gaming desktop to the designated realm.");
  await page.getByRole("button", { name: "Submit access request" }).click();
  await expect(page.getByText("pending", { exact: true })).toBeVisible();
  const admin = await browser.newContext();
  const staff = await admin.newPage();
  await signIn(staff, "dev-owner");
  await staff
    .getByRole("button", { name: "Administration", exact: true })
    .click();
  await staff.getByRole("button", { name: "approvals", exact: true }).click();
  await staff
    .getByLabel("Decision reason")
    .fill("Approved for community gaming");
  await staff.getByLabel("Type APPROVE when approving access").fill("APPROVE");
  await staff.getByRole("button", { name: "Record decision" }).click();
  await expect
    .poll(async () => {
      const response = await page.request.get("/api/access");
      return (await response.json()).grants.some(
        (g: any) =>
          g.snapshot.key === "network.gaming" && g.fulfillment === "active",
      );
    })
    .toBe(true);
  await page.reload();
  await expect(page.locator(".pill.active").first()).toBeVisible();
  await page.getByRole("button", { name: "My devices", exact: true }).click();
  await expect(page.getByRole("heading", { name: "▱ Desktop" })).toBeVisible();
  await expect(page.getByText("100.90.0.2", { exact: true })).toBeVisible();
  await staff.getByRole("button", { name: "network", exact: true }).click();
  await expect(staff.getByText("Gaming access", { exact: true })).toBeVisible();
  await expect(
    staff.getByText("Broad existing policy may independently permit access;", {
      exact: false,
    }),
  ).toBeVisible();
  await admin.close();
});
test("unavailable WoW fulfillment is blocked and admin can explicitly attest manual setup", async ({
  browser,
  page,
}) => {
  await signIn(page);
  await page
    .getByRole("button", { name: "World of Warcraft", exact: true })
    .click();
  await expect(
    page.getByText("Request access to see protected connection details"),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Request access", exact: true })
    .click();
  await page
    .getByLabel("Why would you like access?")
    .fill("I would like to join the realm with the community.");
  await page.getByRole("button", { name: "Submit access request" }).click();
  const admin = await browser.newContext();
  const staff = await admin.newPage();
  await signIn(staff, "dev-owner");
  await staff
    .getByRole("button", { name: "Administration", exact: true })
    .click();
  await staff.getByRole("button", { name: "approvals", exact: true }).click();
  await staff
    .getByLabel("Decision reason")
    .fill("Manual account setup will be recorded separately");
  await staff.getByLabel("Type APPROVE when approving access").fill("APPROVE");
  await staff.getByRole("button", { name: "Record decision" }).click();
  await expect
    .poll(async () => {
      const response = await page.request.get("/api/access");
      return (await response.json()).grants.some(
        (g: any) =>
          g.snapshot.key === "game.wow.player" && g.fulfillment === "blocked",
      );
    })
    .toBe(true);
  await page.reload();
  await expect(
    page.getByText("Awaiting API specification; manual attestation available", {
      exact: false,
    }),
  ).toBeVisible();
  await staff.getByRole("button", { name: "access", exact: true }).click();
  await staff
    .locator("details")
    .filter({
      has: staff.getByText(
        /Awaiting API specification; manual attestation available/,
      ),
    })
    .first()
    .locator("summary")
    .first()
    .click();
  await staff
    .getByText("Attest manual fulfillment", { exact: true })
    .first()
    .click();
  const form = staff.locator("form").filter({
    has: staff.getByRole("button", { name: "Attest manual fulfillment" }),
  });
  await form.locator("textarea").fill(
    JSON.stringify({
      reason: "Manually configured the designated test account",
      confirmation: "ATTEST",
    }),
  );
  await form.getByRole("button", { name: "Attest manual fulfillment" }).click();
  await page.getByRole("button", { name: "Services", exact: true }).click();
  await expect
    .poll(async () => {
      const response = await page.request.get("/api/access");
      return (await response.json()).grants.some(
        (g: any) =>
          g.snapshot.key === "game.wow.player" && g.fulfillment === "active",
      );
    })
    .toBe(true);
  await page.reload();
  await expect(
    page
      .locator(".card")
      .filter({
        has: page.getByRole("button", {
          name: "World of Warcraft",
          exact: true,
        }),
      })
      .getByText("active", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "World of Warcraft", exact: true })
    .click();
  await expect(
    page.getByText("realm.example.invalid:3724", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /restart/i })).toHaveCount(0);
  await admin.close();
});
test("support ticket persists and keyboard dialog closes with Escape", async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole("button", { name: "Support", exact: true }).click();
  await page.getByRole("button", { name: "+ New ticket" }).click();
  await page
    .getByLabel("Subject", { exact: true })
    .fill("Realm client setup help");
  await page
    .getByLabel("What happened?")
    .fill("I need help choosing the correct realm connection setting.");
  await page.getByRole("button", { name: "Create ticket" }).click();
  await expect(
    page.getByRole("heading", { name: "Realm client setup help" }),
  ).toBeVisible();
  await page
    .getByLabel("Reply", { exact: true })
    .fill("I have checked the instructions.");
  await page.getByRole("button", { name: "Send reply" }).click();
  await expect(
    page.getByText("I have checked the instructions.", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
test("mobile card gallery fits viewport and has named navigation controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/mobile-gallery.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Community hub", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("service editing preserves dependency mappings", async ({ page }) => {
  await signIn(page, "dev-owner");
  const { csrf } = await (await page.request.get("/api/me")).json();
  const headers = { "x-csrf-token": csrf, origin: "http://localhost:3000" };
  const dependency = await (
    await page.request.post("/api/services", {
      headers,
      data: {
        name: "Hidden browser dependency",
        slug: "browser-dependency",
        summary: "Internal service",
        visibility: "admin",
        metadata: {},
      },
    })
  ).json();
  const root = await (
    await page.request.post("/api/services", {
      headers,
      data: {
        name: "Browser dependency edit",
        slug: "browser-root",
        summary: "Before editing",
        visibility: "discoverable",
        metadata: {},
        dependencies: [{ id: dependency.id, required: false }],
      },
    })
  ).json();
  await page.reload();
  await page
    .getByRole("button", { name: "Browser dependency edit", exact: true })
    .click();
  await page.getByRole("button", { name: "Edit service", exact: true }).click();
  await expect(
    page.getByLabel("Dependencies (JSON: id, required)"),
  ).toHaveValue(JSON.stringify([{ id: dependency.id, required: false }]));
  await page.getByLabel("Card description").fill("After editing");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const saved = await (
    await page.request.get(`/api/services/${root.id}`)
  ).json();
  expect(saved.summary).toBe("After editing");
  expect(saved.dependencies).toEqual([{ id: dependency.id, required: false }]);
});

test("provider inspection failures are visible and can be retried", async ({
  page,
}) => {
  await signIn(page, "dev-owner");
  await page
    .getByRole("button", { name: "Administration", exact: true })
    .click();
  await page.getByRole("button", { name: "users", exact: true }).click();
  await page.route("**/api/admin/pocket-id", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "provider_unavailable" }),
    }),
  );
  const inspect = page.getByRole("button", {
    name: "Inspect Pocket ID directory",
  });
  await inspect.click();
  await expect(page.getByRole("alert")).toContainText("provider unavailable");
  await expect(inspect).toBeEnabled();
  await page.unroute("**/api/admin/pocket-id");
  await inspect.click();
  await expect(
    page.getByRole("heading", { name: "Pocket ID users" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("required rules and onboarding progress survive sign-out", async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole("button", { name: "Get started", exact: true }).click();
  await page.locator("summary").filter({ hasText: "Community rules" }).click();
  await page.getByRole("button", { name: "Acknowledge this version" }).click();
  await expect(page.getByText("acknowledged", { exact: true })).toBeVisible();
  const rules = page.locator(".panel").filter({
    has: page.getByRole("heading", { name: "Review community rules" }),
  });
  await rules.getByRole("button", { name: "Mark complete" }).click();
  await expect(rules.getByText("complete", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Sign in with Pocket ID" }),
  ).toBeVisible();
  await signIn(page);
  await page.getByRole("button", { name: "Get started", exact: true }).click();
  await expect(rules.getByText("complete", { exact: true })).toBeVisible();
});
