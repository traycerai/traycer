import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PerWindowSnapshot } from "../../../ipc-contracts/window-types";
import { DesktopStateStore } from "../desktop-state-store";

// Injects persist failures at the fs boundary. Everything not overridden
// (mkdtemp/readFile/rm used by the test itself, mkdir/rename used by the
// store) passes through to the real filesystem.
const persistFaults = vi.hoisted(() => ({ writeFailuresRemaining: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const writeFile = (
    path: string,
    data: string,
    options: { encoding: "utf8"; mode: number },
  ): Promise<void> => {
    if (persistFaults.writeFailuresRemaining > 0) {
      persistFaults.writeFailuresRemaining -= 1;
      return Promise.reject(new Error("injected writeFile failure"));
    }
    return actual.writeFile(path, data, options);
  };
  // Mirror the stubs onto `default` too - vite/esbuild CJS interop can read
  // `default.writeFile`, and a spread of the real namespace would otherwise
  // leave the un-mocked implementation reachable there.
  const mocked = { ...actual, writeFile };
  return { ...mocked, default: mocked };
});

const logger = {
  warn: vi.fn(),
  error: vi.fn(),
};

function snapshotWithTab(tabId: string, name: string): PerWindowSnapshot {
  return {
    epicTabs: [{ id: tabId, epicId: "epic-a", name }],
    activeTabId: tabId,
    canvasByTabId: {},
    landingDrafts: [],
    activeLandingDraftId: null,
  };
}

let tempDir: string;
let filePath: string;

beforeEach(async () => {
  persistFaults.writeFailuresRemaining = 0;
  tempDir = await mkdtemp(join(tmpdir(), "traycer-desktop-state-store-"));
  filePath = join(tempDir, "desktop-windows.json");
  logger.warn.mockClear();
  logger.error.mockClear();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// Persist-failure policy: one immediate retry, then surface the terminal
// failure to the caller. A renderer revision may only acknowledge after a
// durable write; `flush()` reports the same failure while a later write still
// starts from a healthy recovery chain. The tmp+rename swap keeps the previous
// on-disk payload intact through any failure.
describe("DesktopStateStore persist-failure policy", () => {
  it("retries a failed persist once and succeeds without escalating", async () => {
    const store = new DesktopStateStore({ filePath, logger });
    await store.load();

    persistFaults.writeFailuresRemaining = 1;
    await store.setWindowSnapshot(
      "window-a",
      snapshotWithTab("tab-a", "Alpha"),
    );
    await store.flush();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    expect(persisted.windows["window-a"].epicTabs[0].name).toBe("Alpha");
  });

  it("rejects after the retry fails, logs the error, and preserves the prior payload", async () => {
    const store = new DesktopStateStore({ filePath, logger });
    await store.load();
    await store.setWindowSnapshot(
      "window-a",
      snapshotWithTab("tab-a", "Alpha"),
    );
    await store.flush();

    persistFaults.writeFailuresRemaining = 2;
    await expect(
      store.setWindowSnapshot("window-a", snapshotWithTab("tab-a", "Beta")),
    ).rejects.toThrow("injected writeFile failure");
    await expect(store.flush()).rejects.toThrow("injected writeFile failure");

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]?.[1]).toMatchObject({ filePath });
    // The atomic tmp+rename swap left the previous good payload untouched.
    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    expect(persisted.windows["window-a"].epicTabs[0].name).toBe("Alpha");
  });

  it("recovers on the next write after a surrendered persist (chain is not poisoned)", async () => {
    const store = new DesktopStateStore({ filePath, logger });
    await store.load();

    persistFaults.writeFailuresRemaining = 2;
    await expect(
      store.setWindowSnapshot("window-a", snapshotWithTab("tab-a", "Alpha")),
    ).rejects.toThrow("injected writeFile failure");
    await expect(store.flush()).rejects.toThrow("injected writeFile failure");
    expect(logger.error).toHaveBeenCalledTimes(1);

    await store.setWindowSnapshot(
      "window-a",
      snapshotWithTab("tab-a", "Gamma"),
    );
    await store.flush();

    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    expect(persisted.windows["window-a"].epicTabs[0].name).toBe("Gamma");
  });
});
