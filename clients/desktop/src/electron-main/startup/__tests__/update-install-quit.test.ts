import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PerWindowSnapshot } from "../../../ipc-contracts/window-types";
import { DesktopStateStore } from "../../windows/desktop-state-store";
import {
  QUIT_HOST_MUTATION_DRAIN_TIMEOUT_MS,
  runUpdateInstallQuitSequence,
} from "../update-install-quit";

vi.mock("../../app/logger", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

function snapshotWithTab(tabId: string, name: string): PerWindowSnapshot {
  return {
    epicTabs: [{ id: tabId, epicId: "epic-a", name }],
    activeTabId: tabId,
    canvasByTabId: {},
    landingDrafts: [],
    activeLandingDraftId: null,
  };
}

// Fixup B4: quit is instant everywhere else - the tech plan's ONE deliberate
// bounded exception is "quit keeps a <=10s best-effort drain of an in-flight
// mutation." This used to be 2 minutes (matching the CLI runner's own per-
// call timeout headroom instead of the quit-time bound), so "Restart to
// install" could hang the app open for two minutes behind a wedged mutation.
describe("QUIT_HOST_MUTATION_DRAIN_TIMEOUT_MS", () => {
  it("is bounded at 10 seconds, per the tech plan's quit-time drain exception", () => {
    expect(QUIT_HOST_MUTATION_DRAIN_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    expect(QUIT_HOST_MUTATION_DRAIN_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe("runUpdateInstallQuitSequence", () => {
  it("drains the host mutation, drains the renderer projection, then authorizes the quit - in that order", async () => {
    const order: string[] = [];
    await runUpdateInstallQuitSequence({
      drainHostMutation: async () => {
        order.push("host-drain");
        return true;
      },
      isInstallPending: () => true,
      drainRendererProjection: async () => {
        order.push("drain");
        return [];
      },
      authorizeQuitAfterFlush: () => {
        order.push("authorize");
      },
      stayOpen: () => {
        order.push("stay-open");
      },
    });

    expect(order).toEqual(["host-drain", "drain", "authorize"]);
  });

  it("still drains and quits when the host mutation drain throws (fail-open)", async () => {
    const order: string[] = [];
    await runUpdateInstallQuitSequence({
      // Fixup D2: push a marker before rejecting - a plain
      // `Promise.reject(...)` leaves no trace that `drainHostMutation` was
      // ever invoked, so a regression that dropped the call entirely would
      // still produce the same ["drain", "authorize"] order.
      drainHostMutation: () => {
        order.push("host-drain-attempt");
        return Promise.reject(new Error("drain blew up"));
      },
      isInstallPending: () => true,
      drainRendererProjection: async () => {
        order.push("drain");
        return [];
      },
      authorizeQuitAfterFlush: () => {
        order.push("authorize");
      },
      stayOpen: () => {
        order.push("stay-open");
      },
    });

    expect(order).toEqual(["host-drain-attempt", "drain", "authorize"]);
  });

  it("still quits when the renderer drain rejects (fail-open)", async () => {
    const order: string[] = [];
    await runUpdateInstallQuitSequence({
      drainHostMutation: async () => true,
      isInstallPending: () => true,
      // Fixup D2: same gap as above - mark the attempt before rejecting so a
      // dropped call to `drainRendererProjection` can't masquerade as one
      // that ran and was caught.
      drainRendererProjection: () => {
        order.push("renderer-drain-attempt");
        return Promise.reject(new Error("renderer went away"));
      },
      authorizeQuitAfterFlush: () => {
        order.push("authorize");
      },
      stayOpen: () => {
        order.push("stay-open");
      },
    });

    expect(order).toEqual(["renderer-drain-attempt", "authorize"]);
  });

  it("stays open without draining when the install failed during the host mutation drain", async () => {
    const order: string[] = [];
    await runUpdateInstallQuitSequence({
      drainHostMutation: async () => true,
      isInstallPending: () => false,
      drainRendererProjection: async () => {
        order.push("drain");
        return [];
      },
      authorizeQuitAfterFlush: () => {
        order.push("authorize");
      },
      stayOpen: () => {
        order.push("stay-open");
      },
    });

    expect(order).toEqual(["stay-open"]);
  });

  it("stays open instead of quitting when quitAndInstall fails while the renderer drain was in flight", async () => {
    const order: string[] = [];
    let installPending = true;
    await runUpdateInstallQuitSequence({
      drainHostMutation: async () => true,
      isInstallPending: () => installPending,
      drainRendererProjection: async () => {
        order.push("drain");
        // quitAndInstall's async failure (e.g. read-only volume) lands
        // while the drain is still awaiting the renderer's reply.
        installPending = false;
        return [];
      },
      authorizeQuitAfterFlush: () => {
        order.push("authorize");
      },
      stayOpen: () => {
        order.push("stay-open");
      },
    });

    expect(order).toEqual(["drain", "stay-open"]);
  });

  describe("state persisted across the install quit", () => {
    let tempDir: string;
    const logger = { warn: vi.fn(), error: vi.fn() };

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "traycer-update-quit-"));
      logger.warn.mockClear();
      logger.error.mockClear();
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it("restores a tab mutated during the host mutation drain on the next launch", async () => {
      const filePath = join(tempDir, "desktop-windows.json");
      const store = new DesktopStateStore({ filePath, logger });
      await store.load();
      // Ambient state as of the "Restart to install" click.
      store.setWindowSnapshot("window-a", snapshotWithTab("tab-a", "Alpha"));

      let flushed: Promise<void> = Promise.resolve();
      await runUpdateInstallQuitSequence({
        // The user renames/moves a tab while the (potentially minutes-long)
        // host mutation drain runs; the renderer holds the change, the
        // main-process store does not yet.
        drainHostMutation: async () => true,
        isInstallPending: () => true,
        // The real drain asks the renderer for a fresh snapshot; the renderer
        // flushes its per-window projection into the store before replying.
        drainRendererProjection: async () => {
          store.setWindowSnapshot(
            "window-a",
            snapshotWithTab("tab-a", "Alpha (edited during drain)"),
          );
          return [];
        },
        authorizeQuitAfterFlush: () => {
          flushed = store.flush();
        },
        stayOpen: () => {
          throw new Error("must not stay open");
        },
      });
      await flushed;

      // Next launch: a fresh store on the same file sees the drained state.
      const nextLaunch = new DesktopStateStore({ filePath, logger });
      await nextLaunch.load();
      expect(nextLaunch.getWindowSnapshots()["window-a"]?.epicTabs).toEqual([
        {
          id: "tab-a",
          epicId: "epic-a",
          name: "Alpha (edited during drain)",
        },
      ]);
    });
  });
});
