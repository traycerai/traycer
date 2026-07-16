import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PerWindowSnapshot } from "../../../ipc-contracts/window-types";
import { DesktopStateStore } from "../../windows/desktop-state-store";
import { runUpdateInstallQuitSequence } from "../update-install-quit";

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

describe("runUpdateInstallQuitSequence", () => {
  it("reconciles the host, drains the renderer projection, then authorizes the quit - in that order", async () => {
    const order: string[] = [];
    await runUpdateInstallQuitSequence({
      reconcileHostUpdate: async () => {
        order.push("reconcile");
        return "updated";
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

    expect(order).toEqual(["reconcile", "drain", "authorize"]);
  });

  it("still drains and quits when the host reconcile throws (fail-open)", async () => {
    const order: string[] = [];
    await runUpdateInstallQuitSequence({
      reconcileHostUpdate: () => Promise.reject(new Error("reconcile blew up")),
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

    expect(order).toEqual(["drain", "authorize"]);
  });

  it("still quits when the renderer drain rejects (fail-open)", async () => {
    const order: string[] = [];
    await runUpdateInstallQuitSequence({
      reconcileHostUpdate: async () => "up-to-date",
      isInstallPending: () => true,
      drainRendererProjection: () =>
        Promise.reject(new Error("renderer went away")),
      authorizeQuitAfterFlush: () => {
        order.push("authorize");
      },
      stayOpen: () => {
        order.push("stay-open");
      },
    });

    expect(order).toEqual(["authorize"]);
  });

  it("stays open without draining when the install failed during the reconcile", async () => {
    const order: string[] = [];
    await runUpdateInstallQuitSequence({
      reconcileHostUpdate: async () => "updated",
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
      reconcileHostUpdate: async () => "updated",
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

    it("restores a tab mutated during the host reconcile on the next launch", async () => {
      const filePath = join(tempDir, "desktop-windows.json");
      const store = new DesktopStateStore({ filePath, logger });
      await store.load();
      // Ambient state as of the "Restart to install" click.
      store.setWindowSnapshot("window-a", snapshotWithTab("tab-a", "Alpha"));

      let flushed: Promise<void> = Promise.resolve();
      await runUpdateInstallQuitSequence({
        // The user renames/moves a tab while the (potentially minutes-long)
        // host reconcile runs; the renderer holds the change, the main-process
        // store does not yet.
        reconcileHostUpdate: async () => "updated",
        isInstallPending: () => true,
        // The real drain asks the renderer for a fresh snapshot; the renderer
        // flushes its per-window projection into the store before replying.
        drainRendererProjection: async () => {
          store.setWindowSnapshot(
            "window-a",
            snapshotWithTab("tab-a", "Alpha (edited during reconcile)"),
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
          name: "Alpha (edited during reconcile)",
        },
      ]);
    });
  });
});
