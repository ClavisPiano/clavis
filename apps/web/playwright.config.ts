import { defineConfig, devices } from "@playwright/test";

// Set CHROMIUM_EXECUTABLE_PATH to use a preinstalled Chromium whose revision differs from the one
// this Playwright version expects (for example /opt/pw-browsers/chromium-1194/chrome-linux/chrome).
// CI installs the matching browsers with `playwright install` and leaves it unset. WebKit has no
// local override: it only runs where `playwright install webkit` was done (CI).
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:4173",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(executablePath ? { launchOptions: { executablePath } } : {}),
      },
    },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "Mobile Safari", use: { ...devices["iPhone 15"] } },
  ],
  webServer: {
    command: "pnpm build && pnpm preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
