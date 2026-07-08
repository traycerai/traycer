import "../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchAction,
  findActionForChord,
  matchDigitAction,
  registerBaseLeaderScope,
  registerDynamicActionHandler,
  type KeybindingRouter,
} from "@/lib/keybindings/dispatch";
import { paneTabRefs } from "@/stores/epics/canvas/actions";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { existingEpicTabIntent } from "@/lib/tab-navigation";
import { tabActivate } from "@/stores/tabs/registry";
import { setSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import type {
  OpenSettingsModalOpts,
  SystemOverlayKind,
} from "@/stores/tabs/system-overlay-types";
import { useTabsStore } from "@/stores/tabs/store";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import { getDefaultBindings } from "@/lib/keybindings/actions";
import type { SettingsSectionId } from "@/lib/settings-sections";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";

interface NavigateCall {
  readonly kind: "home" | "settings" | "epic" | "section" | "back" | "forward";
  readonly epicId: string | null;
  readonly sectionId: SettingsSectionId | null;
}

interface MockRouter {
  readonly router: KeybindingRouter;
  readonly calls: Array<NavigateCall>;
  readonly setPath: (next: string) => void;
}

function setActiveSystemOverlay(kind: SystemOverlayKind): void {
  setSystemTabModalApi({
    active: { kind, section: kind === "settings" ? "general" : null },
    openSettings: (_opts: OpenSettingsModalOpts) => undefined,
    openHistory: () => undefined,
    close: () => undefined,
    setSection: (_section: SettingsSectionId) => undefined,
    promoteToTab: () => undefined,
    isOverlayActive: (candidate) => candidate === kind,
  });
}

function specRef(id: "spec-a" | "spec-b"): EpicNodeRef {
  return {
    id,
    instanceId: `${id}-instance`,
    type: "spec",
    name: id === "spec-a" ? "Spec A" : "Spec B",
    hostId: "host-a",
  };
}

function canvasTabIds(tabId: string): ReadonlyArray<string> {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  if (canvas === undefined) return [];
  return collectPanes(canvas.root).flatMap((pane) =>
    paneTabRefs(canvas, pane).map((tab) => tab.id),
  );
}

function buildRouter(initialPath: string): MockRouter {
  const calls: Array<NavigateCall> = [];
  let pathname = initialPath;
  const router: KeybindingRouter = {
    getPathname: () => pathname,
    navigateHome: () => {
      calls.push({ kind: "home", epicId: null, sectionId: null });
      pathname = "/";
    },
    navigateSettings: () => {
      calls.push({ kind: "settings", epicId: null, sectionId: null });
      pathname = "/settings/general";
    },
    navigateToEpic: (epicId) => {
      calls.push({ kind: "epic", epicId, sectionId: null });
      pathname = `/epics/${epicId}/${epicId}`;
    },
    navigateToEpicTab: (tab) => {
      calls.push({ kind: "epic", epicId: tab.epicId, sectionId: null });
      pathname = `/epics/${tab.epicId}/${tab.tabId}`;
    },
    navigateToEpicList: () => {
      calls.push({ kind: "epic", epicId: null, sectionId: null });
      pathname = "/epics";
    },
    navigateSettingsSection: (sectionId) => {
      calls.push({ kind: "section", epicId: null, sectionId });
      pathname = `/settings/${sectionId}`;
    },
    navigateToTabIntent: (intent) => {
      if (intent.kind === "epic") {
        calls.push({ kind: "epic", epicId: intent.epicId, sectionId: null });
        pathname = `/epics/${intent.epicId}/${intent.tabId}`;
      } else if (intent.kind === "draft") {
        calls.push({ kind: "home", epicId: null, sectionId: null });
        pathname = "/";
      } else if (intent.kind === "history") {
        calls.push({ kind: "epic", epicId: null, sectionId: null });
        pathname = "/epics";
      } else {
        calls.push({
          kind: "section",
          epicId: null,
          sectionId: intent.section,
        });
        pathname = `/settings/${intent.section}`;
      }
    },
    goBack: () => {
      calls.push({ kind: "back", epicId: null, sectionId: null });
    },
    goForward: () => {
      calls.push({ kind: "forward", epicId: null, sectionId: null });
    },
    isHistoryNavAvailable: () => false,
    canGoBack: () => false,
    canGoForward: () => false,
  };
  const setPath = (next: string) => {
    pathname = next;
  };
  return { router, calls, setPath };
}

describe("dispatchAction", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
    seedEpicTabs();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    setSystemTabModalApi(null);
    useTabsStore.setState({
      stripOrder: [],
      systemTabs: { history: null, settings: null },
    });
  });

  it("epic.new navigates home", () => {
    const { router, calls } = buildRouter("/epics/e1");
    const fired = dispatchAction("epic.new", router);
    expect(fired).toBe(true);
    expect(calls[0].kind).toBe("home");
  });

  it("app.settings.open navigates to settings", () => {
    const { router, calls } = buildRouter("/");
    const fired = dispatchAction("app.settings.open", router);
    expect(fired).toBe(true);
    expect(calls[0].kind).toBe("settings");
  });

  it("app.history.open defaults to mod+y and navigates to history", () => {
    const { router, calls } = buildRouter("/");

    expect(getDefaultBindings()["app.history.open"]).toBe("mod+y");
    expect(findActionForChord("mod+y")).toBe("app.history.open");

    const fired = dispatchAction("app.history.open", router);

    expect(fired).toBe(true);
    expect(calls[0].kind).toBe("epic");
    expect(router.getPathname()).toBe("/epics");
  });

  it("app.sidebar.toggle no-ops when no bridge is registered", () => {
    const { router } = buildRouter("/epics/e1");
    const fired = dispatchAction("app.sidebar.toggle", router);
    expect(fired).toBe(false);
  });

  it("dispatches through the dynamic registry when a handler is registered", () => {
    const { router } = buildRouter("/epics/e1");
    const spy = vi.fn();
    const unregister = registerDynamicActionHandler("app.sidebar.toggle", spy);
    try {
      const fired = dispatchAction("app.sidebar.toggle", router);
      expect(fired).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });

  it("cycles Epic-level header tabs with the Epic next/previous actions", () => {
    const firstTabId = useEpicCanvasStore.getState().openTabOrder[0];
    const { router, calls } = buildRouter(`/epics/e1/${firstTabId}`);

    expect(dispatchAction("epic.next", router)).toBe(true);
    expect(calls[0].kind).toBe("epic");
    expect(calls[0].epicId).toBe("e2");

    expect(dispatchAction("epic.prev", router)).toBe(true);
    expect(calls[1].kind).toBe("epic");
    expect(calls[1].epicId).toBe("e1");
  });

  it("keeps tab next/previous scoped to tabs within the active pane", () => {
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-pane-tabs", "Pane Tabs");
    useEpicCanvasStore.getState().openTileInTab(tabId, specRef("spec-a"));
    useEpicCanvasStore.getState().openTileInTab(tabId, specRef("spec-b"));
    const beforeHeaderTabId = useEpicCanvasStore.getState().activeTabId;

    const { router, calls } = buildRouter(`/epics/epic-pane-tabs/${tabId}`);
    expect(dispatchAction("tab.prev", router)).toBe(true);

    expect(calls.length).toBe(0);
    expect(useEpicCanvasStore.getState().activeTabId).toBe(beforeHeaderTabId);
    expect(canvasTabIds(tabId)).toEqual(["spec-a", "spec-b"]);
  });

  it("focuses the target pane editor after directional group focus", () => {
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-pane-focus", "Pane Focus");
    useEpicCanvasStore.getState().openTileInTab(tabId, specRef("spec-a"));
    const sourcePaneId =
      useEpicCanvasStore.getState().canvasByTabId[tabId]?.activePaneId ?? null;
    if (sourcePaneId === null) throw new Error("expected source pane");

    useEpicCanvasStore
      .getState()
      .splitPaneWithNode(tabId, sourcePaneId, "right", specRef("spec-b"));
    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    const targetPaneId =
      collectPanes(canvas?.root ?? null).find(
        (pane) => pane.id !== sourcePaneId,
      )?.id ?? null;
    if (targetPaneId === null) throw new Error("expected target pane");
    useEpicCanvasStore.getState().setActiveTilePane(tabId, sourcePaneId);

    appendFocusPane(sourcePaneId, [0, 0, 500, 600]);
    const targetEditor = appendFocusPane(targetPaneId, [500, 0, 500, 600]);

    const { router } = buildRouter(`/epics/epic-pane-focus/${tabId}`);

    expect(dispatchAction("group.focus.right", router)).toBe(true);
    expect(
      useEpicCanvasStore.getState().canvasByTabId[tabId]?.activePaneId,
    ).toBe(targetPaneId);
    expect(document.activeElement).toBe(targetEditor);
  });

  it("does not close hidden epic canvas tabs while a non-detail route is active", () => {
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-route-guard", "Route Guard");
    useEpicCanvasStore.getState().openTileInTab(tabId, specRef("spec-a"));
    useEpicCanvasStore.getState().openTileInTab(tabId, specRef("spec-b"));
    const before = canvasTabIds(tabId);

    ["/", "/draft/draft-a", "/epics"].forEach((pathname) => {
      const { router } = buildRouter(pathname);
      const fired = dispatchAction("tab.close", router);

      expect(fired).toBe(false);
      expect(canvasTabIds(tabId)).toEqual(before);
    });
  });

  it("does not close epic canvas tabs behind a settings overlay", () => {
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-route-guard", "Route Guard");
    useEpicCanvasStore.getState().openTileInTab(tabId, specRef("spec-a"));
    useEpicCanvasStore.getState().openTileInTab(tabId, specRef("spec-b"));
    setActiveSystemOverlay("settings");
    const before = canvasTabIds(tabId);

    const { router } = buildRouter(`/epics/epic-route-guard/${tabId}`);
    const fired = dispatchAction("tab.close", router);

    expect(fired).toBe(false);
    expect(canvasTabIds(tabId)).toEqual(before);
  });

  it("does not close epic canvas tabs while a draft is the active surface", () => {
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-route-guard", "Route Guard");
    useEpicCanvasStore.getState().openTileInTab(tabId, specRef("spec-a"));
    useEpicCanvasStore.getState().openTileInTab(tabId, specRef("spec-b"));
    useLandingDraftStore.getState().createDraft(null);
    const before = canvasTabIds(tabId);

    const { router } = buildRouter(`/epics/epic-route-guard/${tabId}`);
    const fired = dispatchAction("tab.close", router);

    expect(fired).toBe(false);
    expect(canvasTabIds(tabId)).toEqual(before);
  });

  it("closes epic canvas tabs again after the epic tab is activated", () => {
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-route-active", "Route Active");
    useEpicCanvasStore.getState().openTileInTab(tabId, specRef("spec-a"));
    useEpicCanvasStore.getState().openTileInTab(tabId, specRef("spec-b"));
    useLandingDraftStore.getState().createDraft(null);
    tabActivate(
      existingEpicTabIntent({
        epicId: "epic-route-active",
        tabId,
        focus: undefined,
      }),
    );

    const { router } = buildRouter(`/epics/epic-route-active/${tabId}`);
    const fired = dispatchAction("tab.close", router);

    expect(fired).toBe(true);
    expect(canvasTabIds(tabId)).toEqual(["spec-a"]);
  });

  it("closes the active canvas tab while an epic detail route is active", () => {
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-route-active", "Route Active");
    useEpicCanvasStore.getState().openTileInTab(tabId, specRef("spec-a"));
    useEpicCanvasStore.getState().openTileInTab(tabId, specRef("spec-b"));

    const { router } = buildRouter(`/epics/epic-route-active/${tabId}`);
    const fired = dispatchAction("tab.close", router);

    expect(fired).toBe(true);
    expect(canvasTabIds(tabId)).toEqual(["spec-a"]);
  });
});

function appendFocusPane(
  paneId: string,
  box: [number, number, number, number],
): HTMLElement {
  const [x, y, width, height] = box;
  const pane = document.createElement("div");
  pane.setAttribute("data-group-id", paneId);
  document.body.append(pane);
  vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(
    new DOMRect(x, y, width, height),
  );

  const editor = document.createElement("button");
  editor.type = "button";
  editor.setAttribute("data-artifact-editor", "");
  pane.append(editor);
  return editor;
}

// Fire a leader digit through the base scopes, the way the provider's keydown
// handler does: register the scopes for this router, match a synthetic
// modifier+digit event, run it. `modifier` picks Cmd/Ctrl vs Option/Alt.
function fireDigit(
  router: KeybindingRouter,
  digit: number,
  modifier: "mod" | "alt",
): boolean {
  const unregister = registerBaseLeaderScope(router);
  try {
    const match = matchDigitAction(
      new KeyboardEvent("keydown", {
        code: digit === 0 ? "Digit0" : `Digit${digit}`,
        metaKey: modifier === "mod",
        altKey: modifier === "alt",
      }),
    );
    return match === null ? false : match.run();
  } finally {
    unregister();
  }
}

describe("leader digit dispatch (global scope)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
    seedEpicTabs();
  });

  afterEach(() => {
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("alt digit 2 switches to the 2nd open epic", () => {
    const { router, calls } = buildRouter("/epics/e1");
    expect(fireDigit(router, 2, "alt")).toBe(true);
    expect(calls[0].kind).toBe("epic");
    expect(calls[0].epicId).toBe("e2");
  });

  it("cmd digit 2 switches to the 2nd tab in the active Epic group", () => {
    const tabId = useEpicCanvasStore.getState().activeTabId;
    if (tabId === null) throw new Error("expected an active tab");
    useEpicCanvasStore.getState().openTileInTab(tabId, specRef("spec-a"));
    useEpicCanvasStore.getState().openTileInTab(tabId, specRef("spec-b"));

    const { router } = buildRouter(`/epics/e1/${tabId}`);
    expect(fireDigit(router, 2, "mod")).toBe(true);

    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    const paneId = canvas?.activePaneId ?? null;
    const pane =
      paneId === null
        ? null
        : (collectPanes(canvas?.root ?? null).find(
            (candidate) => candidate.id === paneId,
          ) ?? null);
    expect(pane?.activeTabId).toBe("spec-b-instance");
  });

  it("digit 0 is not a single-key Epic-level tab shortcut", () => {
    const { router, calls } = buildRouter("/epics/e1");
    expect(fireDigit(router, 0, "alt")).toBe(false);
    expect(calls.length).toBe(0);
  });

  it("alt digit 5 returns false when only 3 header tabs are open", () => {
    const { router, calls } = buildRouter("/epics/e1");
    expect(fireDigit(router, 5, "alt")).toBe(false);
    expect(calls.length).toBe(0);
  });

  it("settings section digit navigates to the Nth section", () => {
    const { router, calls } = buildRouter("/settings/general");
    expect(fireDigit(router, 2, "alt")).toBe(true);
    expect(calls[0].kind).toBe("section");
    expect(calls[0].sectionId).toBe("appearance");
  });
});

function seedEpicTabs(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useTabsStore.setState({
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
  const firstTabId = useEpicCanvasStore.getState().openEpicTab("e1", "Epic 1");
  useEpicCanvasStore.getState().openEpicTab("e2", "Epic 2");
  useEpicCanvasStore.getState().openEpicTab("e3", "Epic 3");
  useEpicCanvasStore.getState().setActiveTab(firstTabId);
  useTabsStore.setState((state) => ({
    ...state,
    stripOrder: useEpicCanvasStore
      .getState()
      .openTabOrder.map((id) => ({ kind: "epic", id })),
  }));
}
