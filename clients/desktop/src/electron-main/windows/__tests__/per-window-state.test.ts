import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PerWindowSnapshot } from "../../../ipc-contracts/window-types";
import { DesktopStateStore } from "../desktop-state-store";
import { EpicWindowOwnership } from "../epic-window-ownership";
import { PerWindowState } from "../per-window-state";

const logger = {
  warn: vi.fn(),
  error: vi.fn(),
};

const DRAFT_SETTINGS_PAYLOAD = {
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "regular",
} as const;

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "traycer-desktop-state-"));
  logger.warn.mockClear();
  logger.error.mockClear();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("PerWindowState + EpicWindowOwnership persistence", () => {
  it("persists per-window snapshots and ownership in the desktop state file", async () => {
    const filePath = join(tempDir, "desktop-windows.json");
    const store = new DesktopStateStore({ filePath, logger });
    await store.load();
    const perWindowState = new PerWindowState(store);
    const ownership = new EpicWindowOwnership(store);
    const observedSnapshots: string[] = [];
    perWindowState.on("change", (change) => {
      observedSnapshots.push(change.windowId);
    });

    perWindowState.update("window-a", {
      epicTabs: [{ id: "tab-a", epicId: "epic-a", name: "Alpha" }],
      activeTabId: "tab-a",
      canvasByTabId: { "tab-a": { split: "left" } },
      landingDrafts: [
        {
          id: "draft-a",
          content: { type: "doc" },
          selection: null,
          lastTouchedAt: 0,
          settings: DRAFT_SETTINGS_PAYLOAD,
          composerMode: null,
          workspace: null,
        },
      ],
      activeLandingDraftId: "draft-a",
    });
    perWindowState.update("window-a", {
      canvasByTabId: { "tab-b": ["nested", 1, true] },
    });
    expect(ownership.claim("tab-a", "epic-a", "window-a")).toEqual({
      ok: true,
    });
    await store.flush();

    const reloaded = new DesktopStateStore({ filePath, logger });
    await reloaded.load();
    const reloadedState = new PerWindowState(reloaded);
    const reloadedOwnership = new EpicWindowOwnership(reloaded);

    expect(reloadedState.get("window-a")).toEqual({
      epicTabs: [{ id: "tab-a", epicId: "epic-a", name: "Alpha" }],
      activeTabId: "tab-a",
      canvasByTabId: {
        "tab-a": { split: "left" },
        "tab-b": ["nested", 1, true],
      },
      landingDrafts: [
        {
          id: "draft-a",
          content: { type: "doc" },
          selection: null,
          lastTouchedAt: 0,
          settings: DRAFT_SETTINGS_PAYLOAD,
          composerMode: null,
          workspace: null,
        },
      ],
      activeLandingDraftId: "draft-a",
    });
    expect(reloadedState.get("missing")).toEqual({
      epicTabs: [],
      activeTabId: null,
      canvasByTabId: {},
      landingDrafts: [],
      activeLandingDraftId: null,
    });
    expect(reloadedOwnership.getOwner("tab-a")).toBe("window-a");
    expect(observedSnapshots).toEqual(["window-a", "window-a"]);
  });

  it("clears a window: removes the snapshot, deletes the disk entry, emits empty", async () => {
    const filePath = join(tempDir, "desktop-windows-clear.json");
    const store = new DesktopStateStore({ filePath, logger });
    await store.load();
    const deleteSpy = vi.spyOn(store, "deleteWindowSnapshot");
    const perWindowState = new PerWindowState(store);

    perWindowState.update("window-a", {
      epicTabs: [{ id: "tab-a", epicId: "epic-a", name: "Alpha" }],
      activeTabId: "tab-a",
      canvasByTabId: { "tab-a": { split: "left" } },
      landingDrafts: [
        {
          id: "draft-a",
          content: { type: "doc" },
          selection: null,
          lastTouchedAt: 0,
          settings: DRAFT_SETTINGS_PAYLOAD,
          composerMode: null,
          workspace: null,
        },
      ],
      activeLandingDraftId: "draft-a",
    });

    const emitted: PerWindowSnapshot[] = [];
    perWindowState.on("change", (change) => {
      emitted.push(change.snapshot);
    });

    perWindowState.clear("window-a");

    const empty = {
      epicTabs: [],
      activeTabId: null,
      canvasByTabId: {},
      landingDrafts: [],
      activeLandingDraftId: null,
    };
    // In-memory snapshot is gone -> get falls back to the empty snapshot.
    expect(perWindowState.get("window-a")).toEqual(empty);
    // Disk entry removed via the store.
    expect(deleteSpy).toHaveBeenCalledWith("window-a");
    // The change event carries the empty snapshot.
    expect(emitted).toEqual([empty]);

    // The cleared window does not survive a persisted reload.
    await store.flush();
    const reloaded = new DesktopStateStore({ filePath, logger });
    await reloaded.load();
    expect(reloaded.getWindowSnapshots()).toEqual({});
  });

  it("refuses duplicate Epic claims and supports transfer/release", () => {
    const ownership = new EpicWindowOwnership(null);

    expect(ownership.claim("tab-a", "epic-a", "window-a")).toEqual({
      ok: true,
    });
    expect(ownership.claim("tab-a", "epic-a", "window-b")).toEqual({
      ok: false,
      currentOwner: "window-a",
    });
    ownership.transfer("tab-a", "window-a", "window-b");
    expect(ownership.getOwner("tab-a")).toBe("window-b");
    expect(ownership.getOwnedTabs("window-b")).toEqual(["tab-a"]);
    ownership.release("tab-a", "window-b");
    expect(ownership.getOwner("tab-a")).toBeNull();
  });

  it("releases every owned tab for a closed window", () => {
    const ownership = new EpicWindowOwnership(null);
    ownership.claim("tab-a", "epic-a", "window-a");
    ownership.claim("tab-b", "epic-b", "window-a");
    ownership.claim("tab-c", "epic-c", "window-b");

    ownership.releaseWindow("window-a");

    expect(ownership.snapshot()).toEqual([
      { tabId: "tab-c", epicId: "epic-c", windowId: "window-b" },
    ]);
  });

  it("deduplicates repeated per-window tabs and drafts", () => {
    const perWindowState = new PerWindowState(null);

    perWindowState.update("window-a", {
      epicTabs: [
        { id: "tab-a", epicId: "epic-a", name: "Alpha" },
        { id: "tab-a", epicId: "epic-a", name: "Alpha" },
      ],
      landingDrafts: [
        {
          id: "draft-a",
          content: { type: "doc" },
          selection: null,
          lastTouchedAt: 0,
          settings: null,
          composerMode: null,
          workspace: null,
        },
        {
          id: "draft-a",
          content: { type: "doc" },
          selection: null,
          lastTouchedAt: 0,
          settings: null,
          composerMode: null,
          workspace: null,
        },
      ],
      activeLandingDraftId: "draft-a",
    });

    expect(perWindowState.get("window-a").epicTabs).toEqual([
      { id: "tab-a", epicId: "epic-a", name: "Alpha" },
    ]);
    expect(perWindowState.get("window-a").landingDrafts).toEqual([
      {
        id: "draft-a",
        content: { type: "doc" },
        selection: null,
        lastTouchedAt: 0,
        settings: null,
        composerMode: null,
        workspace: null,
      },
    ]);
  });

  it("keeps an empty-named (untitled) tab but drops malformed ones across a persisted reload", async () => {
    const filePath = join(tempDir, "desktop-windows-untitled.json");
    const store = new DesktopStateStore({ filePath, logger });
    await store.load();
    store.setWindowSnapshot("live-window", {
      epicTabs: [
        // Untitled epic/agent: empty name, valid id + epicId - must survive
        // the persisted-snapshot parse (the renderer derives the title).
        { id: "tab-untitled", epicId: "epic-untitled", name: "" },
        // Structurally malformed: no epicId - dropped on parse.
        { id: "tab-bad", epicId: "", name: "Bad" },
      ],
      activeTabId: "tab-untitled",
      canvasByTabId: {},
      landingDrafts: [],
      activeLandingDraftId: null,
    });
    await store.flush();

    const reloaded = new DesktopStateStore({ filePath, logger });
    await reloaded.load();
    const perWindowState = new PerWindowState(reloaded);

    expect(perWindowState.get("live-window").epicTabs).toEqual([
      { id: "tab-untitled", epicId: "epic-untitled", name: "" },
    ]);
  });

  it("restores every persisted window separately under its persisted id", async () => {
    const filePath = join(tempDir, "desktop-windows.json");
    const store = new DesktopStateStore({ filePath, logger });
    await store.load();
    store.setWindowSnapshot("window-a", {
      epicTabs: [{ id: "tab-a", epicId: "epic-a", name: "Alpha" }],
      activeTabId: "tab-a",
      canvasByTabId: { "tab-a": { layout: "left" } },
      landingDrafts: [],
      activeLandingDraftId: null,
    });
    store.setWindowSnapshot("window-b", {
      epicTabs: [{ id: "tab-b", epicId: "epic-b", name: "Beta" }],
      activeTabId: "tab-b",
      canvasByTabId: { "tab-b": { layout: "right" } },
      landingDrafts: [],
      activeLandingDraftId: null,
    });
    await store.flush();

    const reloaded = new DesktopStateStore({ filePath, logger });
    await reloaded.load();
    const restorable = reloaded.getRestorableWindowEntries();
    const result = reloaded.reconcileRestoredWindows({
      liveWindowIds: restorable.map((entry) => entry.windowId),
    });
    await reloaded.flush();
    const perWindowState = new PerWindowState(reloaded);
    const ownership = new EpicWindowOwnership(reloaded);

    expect(restorable.map((entry) => entry.windowId)).toEqual([
      "window-a",
      "window-b",
    ]);
    expect(result.restoredWindowIds).toEqual(["window-a", "window-b"]);
    expect(result.removedDuplicateTabCount).toBe(0);
    // Snapshots stay separate - no fold into a single target.
    expect(perWindowState.get("window-a").epicTabs).toEqual([
      { id: "tab-a", epicId: "epic-a", name: "Alpha" },
    ]);
    expect(perWindowState.get("window-b").epicTabs).toEqual([
      { id: "tab-b", epicId: "epic-b", name: "Beta" },
    ]);
    expect(ownership.snapshot()).toEqual([
      { tabId: "tab-a", epicId: "epic-a", windowId: "window-a" },
      { tabId: "tab-b", epicId: "epic-b", windowId: "window-b" },
    ]);
  });

  it("keeps same-epic tabs with distinct tab ids within and across windows", async () => {
    const store = new DesktopStateStore({
      filePath: join(tempDir, "desktop-windows.json"),
      logger,
    });
    store.setWindowSnapshot("window-a", {
      epicTabs: [
        { id: "tab-1", epicId: "epic-shared", name: "One" },
        { id: "tab-2", epicId: "epic-shared", name: "Two" },
      ],
      activeTabId: "tab-2",
      canvasByTabId: {},
      landingDrafts: [],
      activeLandingDraftId: null,
    });
    store.setWindowSnapshot("window-b", {
      epicTabs: [{ id: "tab-3", epicId: "epic-shared", name: "Three" }],
      activeTabId: "tab-3",
      canvasByTabId: {},
      landingDrafts: [],
      activeLandingDraftId: null,
    });

    const result = store.reconcileRestoredWindows({
      liveWindowIds: ["window-a", "window-b"],
    });
    const perWindowState = new PerWindowState(store);
    const ownership = new EpicWindowOwnership(store);

    expect(result.removedDuplicateTabCount).toBe(0);
    expect(perWindowState.get("window-a").epicTabs).toEqual([
      { id: "tab-1", epicId: "epic-shared", name: "One" },
      { id: "tab-2", epicId: "epic-shared", name: "Two" },
    ]);
    expect(perWindowState.get("window-b").epicTabs).toEqual([
      { id: "tab-3", epicId: "epic-shared", name: "Three" },
    ]);
    expect(ownership.snapshot()).toEqual([
      { tabId: "tab-1", epicId: "epic-shared", windowId: "window-a" },
      { tabId: "tab-2", epicId: "epic-shared", windowId: "window-a" },
      { tabId: "tab-3", epicId: "epic-shared", windowId: "window-b" },
    ]);
    await store.flush();
  });

  it("repairs cross-window duplicate tab ids as corruption, keeping the deterministic winner", async () => {
    const store = new DesktopStateStore({
      filePath: join(tempDir, "desktop-windows.json"),
      logger,
    });
    store.setWindowSnapshot("window-a", {
      epicTabs: [{ id: "tab-dup", epicId: "epic-a", name: "Alpha" }],
      activeTabId: "tab-dup",
      canvasByTabId: { "tab-dup": { layout: "left" } },
      landingDrafts: [],
      activeLandingDraftId: null,
    });
    store.setWindowSnapshot("window-b", {
      epicTabs: [{ id: "tab-dup", epicId: "epic-a", name: "Alpha" }],
      activeTabId: "tab-dup",
      canvasByTabId: { "tab-dup": { layout: "right" } },
      landingDrafts: [],
      activeLandingDraftId: null,
    });

    const result = store.reconcileRestoredWindows({
      liveWindowIds: ["window-b", "window-a"],
    });
    const perWindowState = new PerWindowState(store);
    const ownership = new EpicWindowOwnership(store);

    // window-a wins deterministically (localeCompare order), window-b loses.
    expect(result.removedDuplicateTabCount).toBe(1);
    expect(perWindowState.get("window-a").epicTabs).toEqual([
      { id: "tab-dup", epicId: "epic-a", name: "Alpha" },
    ]);
    expect(perWindowState.get("window-b")).toEqual({
      epicTabs: [],
      activeTabId: null,
      canvasByTabId: {},
      landingDrafts: [],
      activeLandingDraftId: null,
    });
    expect(ownership.snapshot()).toEqual([
      { tabId: "tab-dup", epicId: "epic-a", windowId: "window-a" },
    ]);
    await store.flush();
  });

  it("prunes ownership for tab ids absent from the repaired live snapshots", async () => {
    const store = new DesktopStateStore({
      filePath: join(tempDir, "desktop-windows.json"),
      logger,
    });
    store.setWindowSnapshot("window-a", {
      epicTabs: [{ id: "tab-a", epicId: "epic-a", name: "Alpha" }],
      activeTabId: "tab-a",
      canvasByTabId: {},
      landingDrafts: [],
      activeLandingDraftId: null,
    });
    store.setOwnershipEntries([
      { tabId: "tab-a", epicId: "epic-a", windowId: "window-a" },
      { tabId: "tab-ghost", epicId: "epic-ghost", windowId: "dead-window" },
    ]);

    const result = store.reconcileRestoredWindows({
      liveWindowIds: ["window-a"],
    });
    const ownership = new EpicWindowOwnership(store);

    expect(result.prunedOwnershipCount).toBe(1);
    expect(ownership.snapshot()).toEqual([
      { tabId: "tab-a", epicId: "epic-a", windowId: "window-a" },
    ]);
    await store.flush();
  });

  it("preserves restored empty windows while repairing derived ownership", async () => {
    const store = new DesktopStateStore({
      filePath: join(tempDir, "desktop-windows.json"),
      logger,
    });
    store.setWindowSnapshot("empty-window", {
      epicTabs: [],
      activeTabId: null,
      canvasByTabId: {},
      landingDrafts: [],
      activeLandingDraftId: null,
    });
    store.setOwnershipEntries([
      { tabId: "tab-ghost", epicId: "epic-ghost", windowId: "dead-window" },
    ]);

    const result = store.reconcileRestoredWindows({
      liveWindowIds: ["empty-window"],
    });
    const perWindowState = new PerWindowState(store);
    const ownership = new EpicWindowOwnership(store);

    expect(result.prunedOwnershipCount).toBe(1);
    expect(perWindowState.get("empty-window")).toEqual({
      epicTabs: [],
      activeTabId: null,
      canvasByTabId: {},
      landingDrafts: [],
      activeLandingDraftId: null,
    });
    expect(ownership.snapshot()).toEqual([]);
    await store.flush();
  });
});
