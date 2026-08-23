// BT-501: shared launch fixture for the Electron driver specs.
//
// Skips the entire file when TRAYCER_E2E is unset so plain `vitest`/CI runs
// on machines without Playwright browsers stay green (R12/R13 split: the
// suite exists, it only exercises itself when explicitly asked).

import { test as base, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright-core";
import path from "node:path";

export const E2E_ENABLED = process.env.TRAYCER_E2E === "1";

export interface DesktopApp {
  readonly app: ElectronApplication;
  readonly firstWindow: Page;
}

export const test = base.extend<{ desktopApp: DesktopApp }>({
  desktopApp: [
    async ({}, use, testInfo) => {
      if (!E2E_ENABLED) {
        testInfo.skip(true, "TRAYCER_E2E is not enabled");
        return;
      }
      const executablePath = process.env.TRAYCER_E2E_EXECUTABLE;
      if (executablePath === undefined || executablePath.length === 0) {
        testInfo.skip(
          true,
          "TRAYCER_E2E_EXECUTABLE must point at the built desktop binary",
        );
        return;
      }
      const app = await electron.launch({
        executablePath,
        args: [path.resolve(__dirname, "..", "dist", "main", "index.js")],
      });
      const firstWindow = await app.firstWindow();
      await firstWindow.waitForLoadState("domcontentloaded");
      await use({ app, firstWindow });
      await app.close();
    },
    { auto: true },
  ],
});

/**
 * Read one member of the main-process debug surface (BT-501). Returns null
 * when the shell was launched without TRAYCER_E2E=1.
 */
export async function readManagerDebug<Method extends DebugMethodName>(
  desktopApp: DesktopApp,
  method: Method,
): Promise<ReturnType<BrowserViewManagerDebug[Method]> | null> {
  return desktopApp.app.evaluate(({ }, ...args: unknown[]) => {
    const debug = (
      globalThis as {
        __traycerBrowserViewManagerDebug?: Record<
          string,
          (...callArgs: unknown[]) => unknown
        >;
      }
    ).__traycerBrowserViewManagerDebug;
    if (debug === undefined) return null;
    return debug[method]?.(...args) ?? null;
  }, method) as ReturnType<BrowserViewManagerDebug[Method]> | null;
}

type DebugMethodName =
  | "boundsByKeyId"
  | "occludedKeyIds"
  | "frameCacheStats"
  | "evictedKeyIds";

interface BrowserViewManagerDebug {
  boundsByKeyId(): unknown;
  occludedKeyIds(): unknown;
  frameCacheStats(): unknown;
  evictedKeyIds(): unknown;
}

export { expect };
