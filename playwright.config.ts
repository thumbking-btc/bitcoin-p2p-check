import { defineConfig, devices } from "@playwright/test";

const previewPort = 8_787;
const previewUrl = `http://127.0.0.1:${previewPort}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  failOnFlakyTests: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "line",
  use: {
    baseURL: previewUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: `npm run start:preview -- --ip 127.0.0.1 --port ${previewPort}`,
    url: previewUrl,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      grepInvert: /@pwa/u,
      use: { ...devices["Desktop Chrome"], serviceWorkers: "block" },
    },
    {
      name: "chromium-pwa",
      grep: /@pwa/u,
      use: { ...devices["Desktop Chrome"], serviceWorkers: "allow" },
    },
  ],
});
