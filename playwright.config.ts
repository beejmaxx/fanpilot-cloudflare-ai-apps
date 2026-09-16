import { defineConfig } from "@playwright/test";

const bravePath = process.env.BRAVE_PATH ?? (
  process.platform === "darwin"
    ? "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
    : "/usr/bin/brave-browser"
);
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "list",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://127.0.0.1:4173",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    isCI
      ? { name: "chromium-ci", use: { browserName: "chromium" } }
      : { name: "brave-local", use: { browserName: "chromium", launchOptions: { executablePath: bravePath } } },
  ],
  webServer: {
    command: "npm run dev:e2e -- --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173/api/health",
    reuseExistingServer: !isCI,
    timeout: 120_000,
  },
});
