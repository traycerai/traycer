import { beforeEach, describe, expect, it, vi } from "vitest";
import { openEpicInNewWindow } from "@/lib/commands/actions/open-epic-in-new-window";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { epicCanvasKey } from "@/lib/persist";
import type {
  DesktopOwnershipEntry,
  DesktopWindowsBridge,
} from "@/lib/windows/types";

vi.mock("@/lib/analytics", () => ({
  Analytics: { getInstance: () => ({ track: () => undefined }) },
  AnalyticsEvent: { TaskOpened: "task_opened" },
}));

interface BridgeCalls {
  readonly newRoutes: string[];
  readonly focusedWindows: string[];
}

function makeBridge(options: {
  readonly windowId: string;
  readonly owned: ReadonlyArray<DesktopOwnershipEntry>;
}): { bridge: DesktopWindowsBridge; calls: BridgeCalls } {
  const calls: BridgeCalls = { newRoutes: [], focusedWindows: [] };
  const bridge: DesktopWindowsBridge = {
    windowId: options.windowId,
    list: () => Promise.resolve([]),
    onChange: () => ({ dispose: () => undefined }),
    requestNew: (initialRoute) => {
      calls.newRoutes.push(initialRoute ?? "");
      return Promise.resolve();
    },
    requestFocus: (windowId) => {
      calls.focusedWindows.push(windowId);
      return Promise.resolve();
    },
    requestClose: () => Promise.resolve(),
    requestOpenEpicInNewWindow: () =>
      Promise.resolve({ result: "moved" as const, windowId: "window-x" }),
    ownership: {
      snapshot: () => Promise.resolve([...options.owned]),
      claim: () => Promise.resolve({ ok: true as const }),
      release: () => Promise.resolve(),
      onChange: () => ({ dispose: () => undefined }),
    },
    perWindowState: {
      get: () =>
        Promise.resolve({
          epicTabs: [],
          activeTabId: null,
          canvasByTabId: {},
          landingDrafts: [],
          activeLandingDraftId: null,
        }),
      update: () => Promise.resolve(),
      onChange: () => ({ dispose: () => undefined }),
    },
    authSession: {
      get: () =>
        Promise.resolve({
          status: "signed-out" as const,
          token: null,
          profile: null,
        }),
      set: () => Promise.resolve(),
      onChange: () => ({ dispose: () => undefined }),
    },
  };
  return { bridge, calls };
}

beforeEach(() => {
  window.localStorage.clear();
  useEpicCanvasStore.persist.setOptions({ name: epicCanvasKey(null) });
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
});

describe("openEpicInNewWindow", () => {
  // The "epic already open in THIS window" case is handled upstream by the move
  // flow (see use-history-open-in-new-window), so this helper only covers an
  // epic open elsewhere or open nowhere.
  it("focuses the owning window when the epic is open (mounted) in another window", async () => {
    const { bridge, calls } = makeBridge({
      windowId: "window-a",
      owned: [{ tabId: "tab-1", epicId: "epic-far", windowId: "window-b" }],
    });

    await openEpicInNewWindow(bridge, {
      epicId: "epic-far",
      tabId: "epic-far",
      isPhase: false,
    });

    expect(calls.focusedWindows).toEqual(["window-b"]);
    expect(calls.newRoutes).toEqual([]);
  });

  it("opens a new window at the epic route when the epic is open nowhere", async () => {
    const { bridge, calls } = makeBridge({ windowId: "window-a", owned: [] });

    await openEpicInNewWindow(bridge, {
      epicId: "epic-new",
      tabId: "epic-new",
      isPhase: false,
    });

    expect(calls.focusedWindows).toEqual([]);
    expect(calls.newRoutes).toEqual(["/epics/epic-new/epic-new"]);
  });

  it("ignores the current window's own ownership entry and opens a new window", async () => {
    // A phase that resolved in-place is mounted in THIS window and so holds an
    // ownership entry keyed by its epicId. Phase rows always route here (never
    // through the move flow), so the scan must exclude the current window or it
    // would self-focus instead of opening a new window.
    const { bridge, calls } = makeBridge({
      windowId: "window-a",
      owned: [
        { tabId: "tab-self", epicId: "phase-self", windowId: "window-a" },
      ],
    });

    await openEpicInNewWindow(bridge, {
      epicId: "phase-self",
      tabId: "phase-self",
      isPhase: true,
    });

    expect(calls.focusedWindows).toEqual([]);
    expect(calls.newRoutes).toEqual([
      "/epics/phase-self/phase-self?migrationSource=phase",
    ]);
  });

  it("carries migrationSource=phase in the new-window route for phase rows", async () => {
    const { bridge, calls } = makeBridge({ windowId: "window-a", owned: [] });

    await openEpicInNewWindow(bridge, {
      epicId: "phase-1",
      tabId: "phase-1",
      isPhase: true,
    });

    expect(calls.newRoutes).toEqual([
      "/epics/phase-1/phase-1?migrationSource=phase",
    ]);
  });
});
