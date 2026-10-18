import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  workers: 1,
  timeout: 60000,
  use: { baseURL: "http://localhost:3000", trace: "retain-on-failure" },
  webServer: {
    command: "node --import tsx scripts/e2e-server.ts",
    url: "http://localhost:3000/healthz",
    reuseExistingServer: false,
    timeout: 60000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
