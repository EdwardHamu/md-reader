import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: ["reader.spec.ts", "missions.spec.ts"],
  workers: 1,
  use: { baseURL: "http://127.0.0.1:1420", channel: "msedge", headless: true },
  webServer: {
    command: "pnpm dev --host 127.0.0.1",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: false,
  },
});
