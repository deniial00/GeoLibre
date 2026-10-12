import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const REPO_ROOT = path.resolve(__dirname, "../..");
const port = Number(process.env.MCP_APP_E2E_PORT) || 4186;
const baseURL = process.env.MCP_APP_E2E_BASE_URL ?? `http://localhost:${port}`;

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL,
    ...devices["Desktop Chrome"],
    launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader"] },
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "off",
  },
  webServer: {
    command: "npm run build:mcp-app && node e2e/mcp-app/serve.mjs",
    cwd: REPO_ROOT,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
    env: { MCP_APP_E2E_PORT: String(port) },
  },
});
