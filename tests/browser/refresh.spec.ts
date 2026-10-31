import { test, expect, type Page } from "@playwright/test";

async function signIn(page: Page, user = "dev-owner") {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in with Pocket ID" }).click();
  await page.getByRole("link", { name: user, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your next adventure." }),
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
  await navigate(page, "Games");
  await expect(
    page.getByRole("heading", { name: "Your next adventure." }),
  ).toBeVisible();
});

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
