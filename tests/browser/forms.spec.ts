import { test, expect, type Page, type Locator } from "@playwright/test";
async function admin(page: Page, tab: string) {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in with Pocket ID" }).click();
  await page.getByRole("link", { name: "dev-owner", exact: true }).click();
  await page
    .getByRole("button", { name: "Administration", exact: true })
    .click();
  await page.getByRole("button", { name: tab, exact: true }).click();
}
async function panel(page: Page, title: string) {
  const summary = page
    .locator("summary")
    .filter({ hasText: new RegExp(`^${title}$`) });
  await summary.click();
  return page
    .locator("details")
    .filter({
      has: page
        .locator("summary")
        .filter({ hasText: new RegExp(`^${title}$`) }),
    })
    .last();
}
async function choose(form: Locator, label: string, text: string) {
  const select = form.getByLabel(label, { exact: true });
  await expect(select).toBeEnabled();
  const option = select.locator("option").filter({ hasText: text }).first();
  await expect(option).toHaveCount(1);
  await select.selectOption((await option.getAttribute("value"))!);
}
test("access policy, bundle and provider binding forms submit complete values", async ({
  page,
}) => {
  await admin(page, "access");
  const form = await panel(page, "Create entitlement");
  await form.getByLabel("Key", { exact: true }).fill("browser.forms.access");
  await form.getByLabel("Name", { exact: true }).fill("Browser form access");
  await form
    .getByLabel("Description (Markdown) (optional)")
    .fill("**Read the guide.**");
  await form.getByLabel("Renewable", { exact: true }).uncheck();
  await form.getByLabel("Approvals required").fill("2");
  await form
    .getByRole("button", { name: "Create entitlement", exact: true })
    .click();
  await expect(form.getByText("Saved.", { exact: true })).toBeVisible();
  const all = await (
    await page.request.get("/api/admin/access-configuration")
  ).json();
  const entitlement = all.entitlements.find(
    (e: any) => e.key === "browser.forms.access",
  );
  expect(entitlement.policy.renewable).toBe(false);
  expect(entitlement.policy.approvals).toBe(2);
  const bundle = await panel(page, "Create bundle");
  await bundle.getByLabel("Name", { exact: true }).fill("Browser form bundle");
  await choose(bundle, "Entitlements", "Browser form access");
  await bundle
    .getByRole("button", { name: "Create bundle", exact: true })
    .click();
  await expect(bundle.getByText("Saved.", { exact: true })).toBeVisible();
  const binding = await panel(page, "Manage fulfillment binding");
  await choose(binding, "Entitlement", "Browser form access");
  await choose(binding, "Provider", "Manual fulfillment");
  await binding
    .getByLabel("Instructions (Markdown) (optional)")
    .fill("Create the account in the game server.");
  await binding
    .getByRole("button", { name: "Review manage fulfillment binding" })
    .click();
  await expect(
    binding.getByRole("region", { name: "Review changes" }),
  ).toContainText("Browser form access");
  await binding
    .getByRole("button", { name: "Confirm manage fulfillment binding" })
    .click();
  await expect(binding.getByText("Saved.", { exact: true })).toBeVisible();
});
test("network preview is invalidated by edits and applies only the reviewed values", async ({
  page,
}) => {
  await admin(page, "network");
  const form = await panel(page, "Create narrow policy");
  await form.getByLabel("Name", { exact: true }).fill("Browser narrow policy");
  await choose(form, "Source group", "Gaming access");
  await choose(form, "Destination group", "Realm server");
  await form
    .getByRole("button", { name: "Preview create narrow policy" })
    .click();
  await expect(
    form.getByRole("region", { name: "Review changes" }),
  ).toBeVisible();
  await form.getByLabel("Port", { exact: true }).fill("8085");
  await expect(
    form.getByRole("button", { name: "Confirm create narrow policy" }),
  ).toHaveCount(0);
  await form
    .getByRole("button", { name: "Preview create narrow policy" })
    .click();
  const write = page.waitForRequest(
    (r) =>
      r.url().endsWith("/api/admin/network/policies") && r.method() === "POST",
  );
  await form
    .getByRole("button", { name: "Confirm create narrow policy" })
    .click();
  expect((await write).postDataJSON()).toEqual({
    name: "Browser narrow policy",
    sourceGroup: "nb-gaming",
    destinationGroup: "nb-server",
    protocol: "tcp",
    ports: [8085],
    confirmation: "CREATE POLICY",
  });
  await expect(form.getByText("Saved.", { exact: true })).toBeVisible();
  const resource = await panel(page, "Create routed resource");
  await choose(resource, "Network", "Gaming network");
  await choose(resource, "Service", "Community hub");
  await resource.getByLabel("Name", { exact: true }).fill("Browser host");
  await resource.getByLabel("Single host or domain").fill("192.168.10.9");
  await choose(resource, "Groups", "Realm server");
  await resource
    .getByRole("button", { name: "Preview create routed resource" })
    .click();
  await expect(
    resource.getByRole("region", { name: "Review changes" }),
  ).toContainText("192.168.10.9");
  await resource
    .getByRole("button", { name: "Confirm create routed resource" })
    .click();
  await expect(resource.getByText("Saved.", { exact: true })).toBeVisible();
});
test("provider lookup failures are retryable and never expose manual ID inputs", async ({
  page,
}) => {
  await page.route("**/api/form-options/netbird-users", (r) =>
    r.fulfill({ status: 502, json: { error: "contract_mismatch" } }),
  );
  await admin(page, "network");
  const form = await panel(page, "Verify NetBird identity link");
  await expect(form.getByRole("alert")).toContainText(
    "Could not load provider account",
  );
  await expect(
    form.getByRole("button", { name: "Review verify NetBird identity link" }),
  ).toBeDisabled();
  await expect(form.locator('input[name="externalId"]')).toHaveCount(0);
  await page.unroute("**/api/form-options/netbird-users");
  await form.getByRole("button", { name: "Retry provider account" }).click();
  await choose(form, "Provider account", "Alex");
  await expect(
    form.getByRole("button", { name: "Review verify NetBird identity link" }),
  ).toBeEnabled();
});
test("monitoring changes expose appropriate fields and retain drafts on failure", async ({
  page,
}) => {
  await admin(page, "monitoring");
  const form = await panel(page, "Create health check");
  await choose(form, "Service", "Community hub");
  await form.getByLabel("Check type", { exact: true }).selectOption("tcp");
  await expect(form.getByLabel("URL", { exact: true })).toHaveCount(0);
  await form.getByLabel("Host", { exact: true }).fill("192.168.10.9");
  await form.getByLabel("Check type", { exact: true }).selectOption("manual");
  await expect(form.getByLabel("Host", { exact: true })).toHaveCount(0);
  await page.route("**/api/health/checks", (r) =>
    r.request().method() === "POST"
      ? r.fulfill({
          status: 400,
          json: { error: "validation_failed", fields: ["config.vantage"] },
        })
      : r.continue(),
  );
  await form.getByLabel("Observation location").fill("Operator desk");
  await form
    .getByRole("button", { name: "Create health check", exact: true })
    .click();
  await expect(form.getByRole("alert")).toContainText("validation failed");
  await expect(form.getByLabel("Observation location")).toHaveValue(
    "Operator desk",
  );
  await expect(form.getByLabel("Observation location")).toBeFocused();
  await page.unroute("**/api/health/checks");
  await form
    .getByRole("button", { name: "Create health check", exact: true })
    .click();
  await expect(form.getByText("Saved.", { exact: true })).toBeVisible();
});
test("guides, notices, maintenance and preferences use fillable fields", async ({
  page,
}) => {
  await admin(page, "services");
  const guide = await panel(page, "Create guide");
  await guide.getByLabel("Title", { exact: true }).fill("Browser form guide");
  await guide
    .getByLabel("Body (Markdown)", { exact: true })
    .fill("**Welcome aboard**");
  await guide.getByText("Preview body", { exact: true }).click();
  await expect(guide.locator(".markdown strong")).toHaveText("Welcome aboard");
  await guide
    .getByRole("button", { name: "Create guide", exact: true })
    .click();
  await expect(guide.getByText("Saved.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Guides", exact: true }).click();
  await page
    .locator("summary")
    .filter({ hasText: /^Browser form guide · version/ })
    .click();
  const guideContainer = page
    .locator("details")
    .filter({
      has: page
        .locator("summary")
        .filter({ hasText: /^Browser form guide · version/ }),
    })
    .first();
  const edit = guideContainer.locator("details").filter({
    has: page
      .locator("summary")
      .filter({ hasText: /^Publish new guide version$/ }),
  });
  await edit.locator("summary").click();
  for (const version of [2, 3]) {
    await edit
      .getByLabel("Body (Markdown)", { exact: true })
      .fill(`Guide revision ${version}`);
    await edit
      .getByRole("button", { name: "Publish new guide version", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await (await page.request.get("/api/guides")).json()).find(
            (g: any) => g.title === "Browser form guide",
          ).current_version,
      )
      .toBe(version);
  }
  await page
    .getByRole("button", { name: "Administration", exact: true })
    .click();

  await page.getByRole("button", { name: "notices", exact: true }).click();
  const notice = await panel(page, "Publish announcement");
  await notice
    .getByLabel("Title", { exact: true })
    .fill("Browser announcement");
  await notice
    .getByLabel("Body (Markdown)", { exact: true })
    .fill("Scheduled updates for our community.");
  await notice
    .getByRole("button", { name: "Publish announcement", exact: true })
    .click();
  await expect(notice.getByText("Saved.", { exact: true })).toBeVisible();
  const maintenance = await panel(page, "Schedule maintenance");
  await maintenance
    .getByLabel("Title", { exact: true })
    .fill("Browser maintenance");
  await maintenance.getByLabel("Starts at").fill("2027-01-10T10:00");
  await maintenance.getByLabel("Ends at").fill("2027-01-10T11:00");
  await maintenance
    .getByRole("button", { name: "Schedule maintenance", exact: true })
    .click();
  await expect(maintenance.getByText("Saved.", { exact: true })).toBeVisible();
  const incident = await panel(page, "Create incident");
  await incident.getByLabel("Title", { exact: true }).fill("Browser incident");
  await incident
    .getByLabel("Body (Markdown)", { exact: true })
    .fill("Investigating the service.");
  await incident
    .getByRole("button", { name: "Create incident", exact: true })
    .click();
  await expect(incident.getByText("Saved.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Updates", exact: true }).click();
  const preference = await panel(page, "Update delivery preference");
  await preference.getByLabel("Delivery channel").selectOption("discord");
  await preference.getByLabel("Enable delivery").check();
  await preference
    .getByRole("button", { name: "Update delivery preference", exact: true })
    .click();
  await expect(preference.getByText("Saved.", { exact: true })).toBeVisible();
  await page.reload();
  await panel(page, "Update delivery preference");
  await preference.getByLabel("Delivery channel").selectOption("discord");
  await expect(preference.getByLabel("Enable delivery")).toBeChecked();
});
test("identity forms include names and roles, and secret confirmation hides the value", async ({
  page,
}) => {
  await admin(page, "users");
  const create = await panel(page, "Create Pocket ID user");
  await create.getByLabel("Username", { exact: true }).fill("browser-user");
  await create.getByLabel("First name (optional)").fill("Browser");
  await create.getByLabel("Last name (optional)").fill("User");
  await create.getByLabel("Display name (optional)").fill("Browser User");
  await create
    .getByRole("button", { name: "Review create Pocket ID user" })
    .click();
  await create
    .getByRole("button", { name: "Confirm create Pocket ID user" })
    .click();
  await expect(create.getByText("Saved.", { exact: true })).toBeVisible();
  const me = await (await page.request.get("/api/me")).json();
  const owner = page
    .locator("details")
    .filter({
      has: page
        .locator("summary")
        .filter({ hasText: new RegExp(`^${me.name}$`) }),
    })
    .last();
  await owner.locator("summary").first().click();
  await owner.getByText("Change portal roles", { exact: true }).click();
  await expect(
    owner.getByText("You cannot change your own roles."),
  ).toBeVisible();
  await page.getByRole("button", { name: "settings", exact: true }).click();
  const secret = await panel(page, "Rotate stored secret");
  await secret
    .getByLabel("Secret name", { exact: true })
    .fill("browser.forms.secret");
  await secret
    .getByLabel("Secret value", { exact: true })
    .fill("very-private-test-value");
  await secret
    .getByRole("button", { name: "Review rotate stored secret" })
    .click();
  await expect(
    secret.getByRole("region", { name: "Review changes" }),
  ).not.toContainText("very-private-test-value");
  await expect(
    secret.getByRole("button", { name: "Confirm rotate stored secret" }),
  ).toBeDisabled();
  await secret
    .getByLabel("Type ROTATE SECRET to confirm")
    .fill("ROTATE SECRET");
  await secret
    .getByRole("button", { name: "Confirm rotate stored secret" })
    .click();
  await expect(secret.getByText("Saved.", { exact: true })).toBeVisible();
  await expect(secret.getByLabel("Secret value", { exact: true })).toHaveValue(
    "",
  );
  await expect(
    secret.getByRole("region", { name: "Operation result" }),
  ).not.toContainText("very-private-test-value");
});

test("unavailable references survive edits and concurrency conflicts require an explicit reload", async ({
  page,
}) => {
  await admin(page, "access");
  const all = await (
    await page.request.get("/api/admin/access-configuration")
  ).json();
  const original = all.entitlements.find(
    (e: any) => e.key === "game.wow.player",
  );
  const me = await (await page.request.get("/api/me")).json();
  const headers = { "x-csrf-token": me.csrf, origin: "http://localhost:3000" };
  const dependency = all.entitlements.find(
    (e: any) => e.key === "network.gaming",
  );
  const save = await page.request.put(`/api/entitlements/${original.id}`, {
    headers,
    data: {
      key: original.key,
      name: original.name,
      policy: original.policy,
      prerequisites: [dependency.id],
      version: original.version,
    },
  });
  expect(save.ok()).toBe(true);
  await page.reload();
  await page.getByRole("button", { name: "access", exact: true }).click();
  await page.route("**/api/form-options/entitlements", (r) =>
    r.fulfill({ json: [] }),
  );
  await page
    .locator("summary")
    .filter({ hasText: /^Realm player · version/ })
    .click();
  const form = await panel(page, "Edit entitlement Realm player");
  await expect(
    form.getByLabel("Prerequisite entitlements").locator("option"),
  ).toContainText(["Unavailable current selection"]);
  await form.getByLabel("Name", { exact: true }).fill("Realm player draft");
  const latest = (
    await (await page.request.get("/api/admin/access-configuration")).json()
  ).entitlements.find((e: any) => e.id === original.id);
  expect(
    (
      await page.request.put(`/api/entitlements/${original.id}`, {
        headers,
        data: {
          key: latest.key,
          name: latest.name,
          policy: latest.policy,
          prerequisites: latest.prerequisites,
          version: latest.version,
        },
      })
    ).ok(),
  ).toBe(true);
  await form
    .getByRole("button", { name: "Edit entitlement Realm player", exact: true })
    .click();
  await expect(
    form.getByText("This record changed while you were editing.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(form.getByLabel("Name", { exact: true })).toHaveValue(
    "Realm player draft",
  );
  await form.getByRole("button", { name: "Reload latest values" }).click();
  await expect(form.getByLabel("Name", { exact: true })).toHaveValue(
    "Realm player",
  );
  await form
    .getByRole("button", { name: "Edit entitlement Realm player", exact: true })
    .click();
  await expect
    .poll(async () => {
      const data = await (
        await page.request.get("/api/admin/access-configuration")
      ).json();
      return data.entitlements.find((e: any) => e.id === original.id).version;
    })
    .toBe(latest.version + 2);
  const saved = (
    await (await page.request.get("/api/admin/access-configuration")).json()
  ).entitlements.find((e: any) => e.id === original.id);
  expect(saved.prerequisites).toEqual([dependency.id]);
  // Restore the fixture's prerequisite so the member fulfillment workflow remains independent.
  expect(
    (
      await page.request.put(`/api/entitlements/${original.id}`, {
        headers,
        data: {
          key: saved.key,
          name: saved.name,
          policy: saved.policy,
          prerequisites: [],
          version: saved.version,
        },
      })
    ).ok(),
  ).toBe(true);
});
