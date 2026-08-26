// BT-501: Playwright Electron harness for browser-tile native behavior.
//
// This directory is intentionally OUTSIDE `src/` so the workspace type-check
// (`tsc --noEmit -p tsconfig.json`, include: ["src"]) never sees it until the
// runner dependency exists at the repo root (deps live only in the ROOT
// package.json — see AGENTS.md).
//
// One-time setup (full steps in e2e/README.md):
//   bun add -d @playwright/test   # at repo ROOT
//   npx playwright install
//   cd traycer/clients/desktop && bun run build
//   TRAYCER_E2E=1 bunx playwright test -c e2e/playwright.config.ts

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  outputDir: "./.results",
  timeout: 60_000,
  retries: process.env.CI === "true" ? 2 : 0,
  workers: 1,
  reporter: [["list"]],
});
