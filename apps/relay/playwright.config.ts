import { defineConfig } from "@playwright/test";

const bravePath = process.env.BRAVE_PATH ?? (process.platform === "darwin"
  ? "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  : "/usr/bin/brave-browser");
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [["line"], ["html", { open: "never" }]] : "list",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: { baseURL: "http://127.0.0.1:4373", screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: [isCI
    ? { name: "chromium-ci", use: { browserName: "chromium" } }
    : { name: "brave-local", use: { browserName: "chromium", launchOptions: { executablePath: bravePath } } }],
  webServer: {
    command: "npm run dev:e2e -- --host 127.0.0.1 --port 4373",
    url: "http://127.0.0.1:4373/api/health",
    reuseExistingServer: !isCI,
    timeout: 120_000,
  },
});
