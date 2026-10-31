import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { encrypt, decrypt, safeUrl } from "../src/security.js";
const env = {
  ENCRYPTION_KEY: "1".repeat(64),
  OIDC_ISSUER: "http://localhost:4100",
  OIDC_CLIENT_ID: "portal",
  OIDC_CLIENT_SECRET: "dev",
};
describe("foundation security", () => {
  it("encrypts and authenticates secret values", () => {
    const encrypted = encrypt("private credential", env.ENCRYPTION_KEY);
    expect(encrypted).not.toContain("private");
    expect(decrypt(encrypted, env.ENCRYPTION_KEY)).toBe("private credential");
    expect(() => decrypt(encrypted, "2".repeat(64))).toThrow();
  });
  it("rejects unsafe launches and credentialed links", () => {
    for (const value of [
      "javascript:alert(1)",
      "file:///tmp/a",
      "https://user:secret@host",
    ])
      expect(() => safeUrl(value, true)).toThrow();
    expect(safeUrl("steam://connect/server", true)).toContain("steam:");
  });
  it("production rejects mock authentication and plaintext origins", () => {
    expect(() => loadConfig({ ...env, NODE_ENV: "production" })).toThrow();
    expect(() =>
      loadConfig({
        ...env,
        NODE_ENV: "production",
        BASE_URL: "https://portal.example",
        OIDC_ISSUER: "https://id.example",
        ENABLE_MOCK_PROVIDERS: "true",
      }),
    ).toThrow();
    const prodWithPrivateWaygate = loadConfig({
      ...env,
      ENCRYPTION_KEY: "a".repeat(64),
      NODE_ENV: "production",
      BASE_URL: "https://portal.example",
      OIDC_ISSUER: "https://id.example",
      WAYGATE_URL: "http://10.0.0.15:8080",
      MANAGEMENT_API_TOKEN: "w".repeat(32),
    });
    expect(prodWithPrivateWaygate.WAYGATE_URL).toBe("http://10.0.0.15:8080");
  });
  it("requires a paired Pterodactyl Client API configuration and production HTTPS", () => {
    expect(() =>
      loadConfig({ ...env, PTERODACTYL_URL: "http://panel.example" }),
    ).toThrow(/configured together/);
    expect(() =>
      loadConfig({
        ...env,
        PTERODACTYL_CLIENT_TOKEN: "pterodactyl-client-token",
      }),
    ).toThrow(/configured together/);
    expect(() =>
      loadConfig({
        ...env,
        ENCRYPTION_KEY: "a".repeat(64),
        NODE_ENV: "production",
        BASE_URL: "https://portal.example",
        OIDC_ISSUER: "https://id.example",
        PTERODACTYL_URL: "http://panel.example",
        PTERODACTYL_CLIENT_TOKEN: "pterodactyl-client-token",
      }),
    ).toThrow(/Invalid integration destination/);
    expect(
      loadConfig({
        ...env,
        PTERODACTYL_URL: "http://127.0.0.1:4200",
        PTERODACTYL_CLIENT_TOKEN: "pterodactyl-client-token",
      }).PTERODACTYL_URL,
    ).toBe("http://127.0.0.1:4200");
  });
});
