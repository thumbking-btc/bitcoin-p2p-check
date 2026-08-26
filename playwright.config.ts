import { defineConfig, devices } from "@playwright/test";

const previewPort = 8_787;
const previewUrl = `http://127.0.0.1:${previewPort}`;
const productionPort = 8_788;
const productionUrl = `http://127.0.0.1:${productionPort}`;
const environmentTestTag = /@(pwa|production-pwa|production-only)\b/u;

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
  webServer: [
    {
      command: `npm run start:preview -- --ip 127.0.0.1 --port ${previewPort}`,
      url: previewUrl,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
    },
    {
      command: `npm run start -- --ip 127.0.0.1 --port ${productionPort}`,
      url: productionUrl,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
    },
  ],
  projects: [
    {
      name: "chromium",
      grepInvert: environmentTestTag,
      use: { ...devices["Desktop Chrome"], baseURL: previewUrl, serviceWorkers: "block" },
    },
    {
      name: "chromium-production",
      grep: /@production-only\b/u,
      use: { ...devices["Desktop Chrome"], baseURL: productionUrl, serviceWorkers: "block" },
    },
    {
      name: "chromium-pwa",
      grep: /@pwa\b/u,
      use: { ...devices["Desktop Chrome"], baseURL: previewUrl, serviceWorkers: "allow" },
    },
    {
      name: "chromium-production-pwa",
      grep: /@production-pwa\b/u,
      use: { ...devices["Desktop Chrome"], baseURL: productionUrl, serviceWorkers: "allow" },
    },
  ],
});
