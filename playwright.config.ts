import { defineConfig } from "@playwright/test";

export default defineConfig({
  testMatch: /(?:index|execute|app)\.test\.ts$/,
  forbidOnly: !!process.env.CI,
  fullyParallel: true,
  workers: 3,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: "http://localhost:8793", trace: "retain-on-failure" },
  webServer: {
    command: "node fixtures/server.mjs",
    url: "http://localhost:8793/health",
    reuseExistingServer: false,
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        launchOptions: { args: ["--disable-features=WebMCP"] },
      },
    },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
    {
      name: "native-chromium",
      testMatch: "native.test.ts",
      use: {
        browserName: "chromium",
        launchOptions: { args: ["--enable-experimental-web-platform-features"] },
      },
    },
  ],
});
