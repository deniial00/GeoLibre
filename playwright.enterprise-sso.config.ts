import { defineConfig, devices } from "@playwright/test";
import { DESKTOP_SETTINGS_STORAGE_KEY } from "./apps/geolibre-desktop/src/lib/storage-keys";

const PORT = 4173;
const BASE_URL = `http://localhost:${PORT}`;

/**
 * Enterprise single sign-on, end to end: the built web app signs in to the
 * projects/identity API (`backend/geolibre_server_api`) through an organization
 * whose identity provider is a real Keycloak. Kept out of the default suites
 * (`playwright.config.ts` ignores `e2e/enterprise-sso/`) because it needs both
 * services already running: the API on http://localhost:8000 and Keycloak on
 * https://localhost:8443 with `e2e/enterprise-sso/geolibre-realm.json`
 * imported. The `enterprise-sso` job in `.github/workflows/e2e-full.yml` starts
 * them; run locally with `npm run test:e2e:sso` after the same commands.
 */

// Same software-WebGL Chromium as the default suites (see playwright.config.ts).
const chromium = {
  ...devices["Desktop Chrome"],
  launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader"] },
};

export default defineConfig({
  testDir: "./e2e/enterprise-sso",
  // One spec that shares one API database and one Keycloak realm.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: BASE_URL,
    // Keycloak serves a self-signed certificate in CI.
    ignoreHTTPSErrors: true,
    // Skip the first-launch onboarding wizard, as in playwright.config.ts.
    storageState: {
      cookies: [],
      origins: [
        {
          origin: BASE_URL,
          localStorage: [
            {
              name: DESKTOP_SETTINGS_STORAGE_KEY,
              value: JSON.stringify({ uiProfile: { onboarded: true } }),
            },
          ],
        },
      ],
    },
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{ name: "enterprise-sso", use: chromium }],
  webServer: {
    command: `npm run build && npm run preview -w geolibre-desktop -- --port ${PORT} --strictPort`,
    // Blank the Cesium token for the same reason as playwright.config.ts, and
    // point project sharing at the local API so the gallery offers sign-in.
    env: {
      CESIUM_TOKEN: "",
      VITE_CESIUM_TOKEN: "",
      VITE_GEOLIBRE_SHARE_URL: "http://localhost:8000",
    },
    url: BASE_URL,
    // Never reuse: a preview built without VITE_GEOLIBRE_SHARE_URL would point
    // the gallery at the wrong server.
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
