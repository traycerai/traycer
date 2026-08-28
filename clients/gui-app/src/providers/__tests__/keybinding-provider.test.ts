import { createElement } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory } from "@tanstack/react-router";
import {
  dispatchAction,
  findActionForChord,
  matchDigitAction,
  registerBaseLeaderScope,
  registerDynamicActionHandler,
  resolveLeaderOwner,
  type KeybindingRouter,
} from "@/lib/keybindings/dispatch";
import type { KeybindingRouterSource } from "@/lib/keybindings/router-adapter";
import { paneTabRefs } from "@/stores/epics/canvas/actions";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { setSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import type {
  OpenSettingsModalOpts,
  SystemOverlayKind,
} from "@/stores/tabs/system-overlay-types";
import { useTabsStore } from "@/stores/tabs/store";
import { tabItemId } from "@/stores/tabs/layout";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import { getDefaultBindings } from "@/lib/keybindings/actions";
import { isMac } from "@/lib/keybindings/platform";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import { KeybindingProvider } from "@/providers/keybinding-provider";
import type { SettingsSectionId } from "@/lib/settings-sections";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import type {
  NavigateNestedFocus,
  PrepareNestedFocusTarget,
} from "@/lib/epic-nested-focus-navigation";

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
  synchronizeLayoutForRoute(initialPath);
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
      } else if (intent.kind === "open-epic") {
        calls.push({ kind: "epic", epicId: intent.epicId, sectionId: null });
        pathname = `/epics/${intent.epicId}`;
      } else if (intent.kind === "open-phase-migration") {
        calls.push({ kind: "epic", epicId: intent.phaseId, sectionId: null });
        pathname = `/epics/${intent.phaseId}`;
      } else if (intent.kind === "complete-epic-migration") {
        calls.push({ kind: "epic", epicId: intent.epicId, sectionId: null });
        pathname = `/epics/${intent.epicId}/${intent.tabId}`;
      } else if (intent.kind === "new-draft") {
        calls.push({ kind: "home", epicId: null, sectionId: null });
        pathname = "/";
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

function synchronizeLayoutForRoute(pathname: string): void {
  const match = /^\/epics\/[^/]+\/([^/]+)$/.exec(pathname);
  const tabId = match?.[1];
  if (tabId === undefined) return;
  const openTabIds = useEpicCanvasStore.getState().openTabOrder;
  if (!openTabIds.includes(tabId)) return;
  useTabsStore.setState((state) => ({
    ...state,
    version: 2,
    items: openTabIds.map((id) => ({
      kind: "tab" as const,
      id: tabItemId({ kind: "epic", id }),
      ref: { kind: "epic" as const, id },
    })),
    activeItemId: tabItemId({ kind: "epic", id: tabId }),
    stripOrder: openTabIds.map((id) => ({ kind: "epic" as const, id })),
  }));
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

  it("walks available app history and no-ops at its boundaries", () => {
    const { router: baseRouter, calls } = buildRouter("/");
    let canGoBack = true;
    let canGoForward = true;
    const router: KeybindingRouter = {
      ...baseRouter,
      isHistoryNavAvailable: () => true,
      canGoBack: () => canGoBack,
      canGoForward: () => canGoForward,
    };

    expect(dispatchAction("nav.back", router)).toBe(true);
    expect(dispatchAction("nav.forward", router)).toBe(true);
    expect(calls.map((call) => call.kind)).toEqual(["back", "forward"]);

    canGoBack = false;
    canGoForward = false;
    expect(dispatchAction("nav.back", router)).toBe(false);
    expect(dispatchAction("nav.forward", router)).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("registers defaults for Resource Monitor and usage limits", () => {
    const defaults = getDefaultBindings();

    expect(defaults["app.resources.open"]).toBe("shift+escape");
    expect(defaults["app.rate-limits.open"]).toBe("mod+shift+u");
    expect(findActionForChord("shift+escape")).toBe("app.resources.open");
    expect(findActionForChord("mod+shift+u")).toBe("app.rate-limits.open");
  });

  it("registers a default binding for the notification center", () => {
    const defaults = getDefaultBindings();

    expect(defaults["app.notifications.open"]).toBe("mod+shift+n");
    expect(findActionForChord("mod+shift+n")).toBe("app.notifications.open");
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

  it("focuses the selected chat editor instead of a retained background editor", () => {
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
    const targetPane = appendPane(targetPaneId, [500, 0, 500, 600]);
    const backgroundLayer = appendTabLayer(targetPane, "background-tab", false);
    appendComposerEditor(backgroundLayer);
    const selectedLayer = appendTabLayer(targetPane, "selected-tab", true);
    appendComposerEditor(selectedLayer);
    const primaryComposer = document.createElement("div");
    primaryComposer.setAttribute("data-chat-composer", "");
    selectedLayer.append(primaryComposer);
    const selectedEditor = appendComposerEditor(primaryComposer);

    const { router } = buildRouter(`/epics/epic-pane-focus/${tabId}`);

    expect(dispatchAction("group.focus.right", router)).toBe(true);
    expect(document.activeElement).toBe(selectedEditor);
  });

  it("requests primary-editor restoration for directional group focus", () => {
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
    const targetPane = appendPane(targetPaneId, [500, 0, 500, 600]);
    const targetLayer = appendTabLayer(targetPane, "selected-tab", true);
    const composer = document.createElement("div");
    composer.setAttribute("data-chat-composer", "");
    targetLayer.append(composer);
    const targetEditor = appendComposerEditor(composer);
    targetEditor.setAttribute("role", "textbox");
    targetEditor.setAttribute("aria-label", "Destination chat composer");

    const { router: baseRouter } = buildRouter(
      `/epics/epic-pane-focus/${tabId}`,
    );
    const navigateNestedFocusToPrimaryEditor: NavigateNestedFocus = vi.fn(
      (
        _epicId: string,
        _nestedTabId: string,
        prepare: PrepareNestedFocusTarget,
      ) => prepare(),
    );
    const router: KeybindingRouter = {
      ...baseRouter,
      navigateNestedFocusToPrimaryEditor,
    };

    expect(dispatchAction("group.focus.right", router)).toBe(true);
    expect(navigateNestedFocusToPrimaryEditor).toHaveBeenCalledWith(
      "epic-pane-focus",
      tabId,
      expect.any(Function),
    );
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Destination chat composer" }),
    );
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
    // Re-activate the epic tab over the just-created draft, mirroring exactly
    // what activateTabIntent does (legacy source projection + layout focus),
    // without importing raw tabActivate: draft cleared, epic focused.
    useEpicCanvasStore.getState().setActiveTab(tabId);
    useLandingDraftStore.getState().clearActiveDraft();
    useTabsStore.getState().focusRef({ kind: "epic", id: tabId });

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

  it("excludes a focused Phase-migration surface from Epic canvas commands and leader scope", () => {
    const tabId = useEpicCanvasStore.getState().openTabOrder[0];
    useEpicCanvasStore.getState().openTileInTab(tabId, specRef("spec-a"));
    useEpicCanvasStore.getState().openTileInTab(tabId, specRef("spec-b"));
    useEpicCanvasStore.setState((state) => {
      const tab = state.tabsById[tabId];
      if (tab === undefined) return state;
      return {
        tabsById: {
          ...state.tabsById,
          [tabId]: {
            ...tab,
            surfaceMode: { kind: "phase-migration", phaseId: tab.epicId },
          },
        },
      };
    });
    const { router } = buildRouter(`/epics/e1/${tabId}`);
    const unregister = registerBaseLeaderScope(router);

    try {
      expect(resolveLeaderOwner("mod")).toBeNull();
      expect(dispatchAction("tab.close", router)).toBe(false);
      expect(canvasTabIds(tabId)).toEqual(["spec-a", "spec-b"]);
    } finally {
      unregister();
    }
  });
});

function appendFocusPane(
  paneId: string,
  box: [number, number, number, number],
): HTMLElement {
  const pane = appendPane(paneId, box);
  const layer = appendTabLayer(pane, "selected-tab", true);
  const editor = document.createElement("button");
  editor.type = "button";
  editor.setAttribute("data-artifact-editor", "");
  layer.append(editor);
  return editor;
}

function appendPane(
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

  return pane;
}

function appendTabLayer(
  pane: HTMLElement,
  tabInstanceId: string,
  selected: boolean,
): HTMLElement {
  const layer = document.createElement("div");
  layer.setAttribute("data-tab-instance-id", tabInstanceId);
  layer.setAttribute("data-selected", selected ? "true" : "false");
  if (!selected) layer.hidden = true;
  pane.append(layer);

  return layer;
}

function appendComposerEditor(parent: HTMLElement): HTMLElement {
  const editor = document.createElement("button");
  editor.type = "button";
  editor.setAttribute("data-composer-editor", "");
  parent.append(editor);
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
    // The section leader now gates on the actual focused ref, not just the
    // /settings pathname, so seed the Settings tab as the focused layout item -
    // the real state when the flat Settings tab owns the screen.
    useTabsStore.getState().openSystemTab({
      kind: "settings",
      name: "Settings",
      lastPath: "/settings/general",
    });
    const { router, calls } = buildRouter("/settings/general");
    expect(fireDigit(router, 2, "alt")).toBe(true);
    expect(calls[0].kind).toBe("section");
    expect(calls[0].sectionId).toBe("appearance");
  });

  it("settings section digit no-ops when [Settings | empty] is focused on empty", () => {
    // F4 (closure): the section leader was pathname-owned. With the empty side
    // of a [Settings | empty] split focused, routeBackingSide keeps the URL on
    // /settings, but Settings does NOT own focus - an Alt-digit section command
    // must no-op instead of stealing focus back to Settings.
    useTabsStore.setState({
      version: 2,
      items: [
        {
          kind: "split",
          id: "split-settings",
          left: { kind: "tab", ref: { kind: "settings", id: "settings" } },
          right: { kind: "empty" },
          focusedSide: "right",
          routeBackingSide: "left",
          leftRatio: 0.5,
        },
      ],
      activeItemId: "split-settings",
      stripOrder: [{ kind: "settings", id: "settings" }],
      systemTabs: {
        history: null,
        settings: {
          id: "settings",
          kind: "settings",
          name: "Settings",
          lastPath: "/settings/general",
        },
      },
    });

    const { router, calls } = buildRouter("/settings/general");
    fireDigit(router, 2, "alt");
    // No settings-section navigation is dispatched - the section leader is
    // inactive because the focused ref is the empty side, not Settings.
    expect(calls.some((call) => call.kind === "section")).toBe(false);
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

// Builds the lightweight `KeybindingRouterSource` `<KeybindingProvider>`
// itself takes (distinct from the `KeybindingRouter` seam `dispatchAction`
// takes above) - just enough for `routerAdapterFor` to read a pathname and
// hand off a no-op `navigate`. Digit-chord tab switches update
// `useEpicCanvasStore` directly (see the `dispatchAction`/`fireDigit` tests
// above), so a real TanStack router isn't needed to observe them.
function buildProviderRouterSource(
  initialPathname: string,
): KeybindingRouterSource {
  const history = createMemoryHistory({ initialEntries: [initialPathname] });
  const navigate: KeybindingRouterSource["navigate"] = () => Promise.resolve();
  return {
    get state() {
      return { location: { pathname: history.location.pathname } };
    },
    history,
    navigate,
  };
}

// Renders the real `<KeybindingProvider>` (so its actual window `keydown`
// capture-phase listener is live) and appends a Diffs-shaped boundary -
// `data-diffs-editor-boundary` wrapping a contenteditable node - directly
// under `document.body`. Returns the contenteditable so tests can dispatch
// real, DOM-composed keydown events at it.
function renderDiffsBoundaryProvider(initialPathname: string): HTMLElement {
  const router = buildProviderRouterSource(initialPathname);
  render(createElement(KeybindingProvider, { router, children: null }));
  const boundary = document.createElement("div");
  boundary.setAttribute("data-diffs-editor-boundary", "");
  const editor = document.createElement("div");
  editor.setAttribute("contenteditable", "true");
  // jsdom does not compute `isContentEditable` from the attribute - stub the
  // browser-computed property `isDiffsEditorEvent` actually reads.
  Object.defineProperty(editor, "isContentEditable", {
    value: true,
    configurable: true,
  });
  boundary.append(editor);
  document.body.append(boundary);
  return editor;
}

function fireKeyDownOn(
  target: HTMLElement,
  init: KeyboardEventInit,
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

function seedManyEpicTabs(count: number): ReadonlyArray<string> {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useTabsStore.setState({
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
  const tabIds = Array.from({ length: count }, (_, index) =>
    useEpicCanvasStore
      .getState()
      .openEpicTab(`m${index + 1}`, `Epic ${index + 1}`),
  );
  useEpicCanvasStore.getState().setActiveTab(tabIds[0]);
  useTabsStore.setState((state) => ({
    ...state,
    stripOrder: useEpicCanvasStore
      .getState()
      .openTabOrder.map((id) => ({ kind: "epic", id })),
  }));
  return tabIds;
}

// Finding: `isDiffsEditorEvent(event)` used to short-circuit `handleKeyDown`
// unconditionally, so a modified chord (⌘1, a reserved shortcut, ...) typed
// while focus sat inside a Diffs editor boundary never reached
// `resolveReservedAction`/`matchDigitAction` at all - even though it was
// never meant to type a character into the editor. The fix only bypasses to
// the editor for BARE (unmodified) typing.
describe("<KeybindingProvider /> inside a Diffs editor boundary", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
    __resetTabNavigationControllerForTesting();
    seedEpicTabs();
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    useTabsStore.setState({
      stripOrder: [],
      systemTabs: { history: null, settings: null },
    });
  });

  it("still resolves a modified chord (alt+digit) as a reserved action while focus is inside the editor", () => {
    const secondTabId = useEpicCanvasStore.getState().openTabOrder[1];
    const editor = renderDiffsBoundaryProvider("/epics/e1");

    act(() => {
      fireKeyDownOn(editor, { code: "Digit2", key: "2", altKey: true });
    });

    expect(useEpicCanvasStore.getState().activeTabId).toBe(secondTabId);
  });

  it("lets bare typing inside the editor bypass the app's keybinding handling", () => {
    const firstTabId = useEpicCanvasStore.getState().activeTabId;
    const editor = renderDiffsBoundaryProvider("/epics/e1");

    let event: KeyboardEvent | undefined;
    act(() => {
      event = fireKeyDownOn(editor, { code: "KeyJ", key: "j" });
    });

    expect(event?.defaultPrevented).toBe(false);
    expect(useEpicCanvasStore.getState().activeTabId).toBe(firstTabId);
  });

  it("never reserves Diffs' native undo and redo chords as app actions", () => {
    useKeybindingStore.setState({
      bindings: {
        ...getDefaultBindings(),
        "app.settings.open": "mod+z",
        "app.history.open": "mod+shift+z",
      },
    });
    const editor = renderDiffsBoundaryProvider("/epics/e1");
    const primaryModifier = isMac() ? { metaKey: true } : { ctrlKey: true };

    const undo = fireKeyDownOn(editor, {
      code: "KeyZ",
      key: "z",
      ...primaryModifier,
    });
    const redo = fireKeyDownOn(editor, {
      code: "KeyZ",
      key: "z",
      ...primaryModifier,
      shiftKey: true,
    });

    expect(undo.defaultPrevented).toBe(false);
    expect(redo.defaultPrevented).toBe(false);
  });

  it("does not let entering the editor mid-chord break a multi-digit sequence typed entirely inside it", () => {
    // Guards the narrower fix over the naive "always reset the pending digit
    // sequence when isDiffsEditorEvent is true" reading: that would wipe the
    // sequence armed by the FIRST digit before the second digit (also fired
    // with focus inside the boundary) ever got to extend it.
    __resetTabNavigationControllerForTesting();
    const tabIds = seedManyEpicTabs(12);
    const editor = renderDiffsBoundaryProvider("/epics/m1");

    act(() => {
      fireKeyDownOn(editor, { code: "Digit1", key: "1", altKey: true });
      fireKeyDownOn(editor, { code: "Digit2", key: "2", altKey: true });
    });

    expect(useEpicCanvasStore.getState().activeTabId).toBe(tabIds[11]);
  });
});
