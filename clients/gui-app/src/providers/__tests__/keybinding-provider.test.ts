import { createElement } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory } from "@tanstack/react-router";
import {
  dispatchAction,
  dispatchKeydownAction,
  findActionForChord,
  flushTabCycle,
  matchDigitAction,
  registerBaseLeaderScope,
  registerDynamicActionHandler,
  resetTabCycle,
  resolveLeaderOwner,
  type KeybindingRouter,
} from "@/lib/keybindings/dispatch";
import type { KeybindingRouterSource } from "@/lib/keybindings/router-adapter";
import {
  hasPreviewDemand,
  paneDemand,
  topLevelDemand,
  useSurfaceDemandStore,
} from "@/stores/tabs/surface-demand";
import { paneTabRefs } from "@/stores/epics/canvas/actions";
import { collectPanes, findPaneById } from "@/stores/epics/canvas/tile-tree";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  RETAINED_PANE_CHAT_CAP,
  retainedPaneChatInstanceIds,
} from "@/stores/epics/canvas/retained-pane-chats";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { setSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import type {
  OpenSettingsModalOpts,
  SystemOverlayKind,
} from "@/stores/tabs/system-overlay-types";
import { useTabsStore } from "@/stores/tabs/store";
import {
  tabActivationHistory,
  tabItemId,
  tabRefKey,
} from "@/stores/tabs/layout";
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
  readonly demands: Array<"preview" | "settled" | undefined>;
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

// Preview demand is process-global transient state; a hold a test abandons must
// not leak into the next test, and activations write it through the shared
// coordinator, so every test also starts from the initial store.
beforeEach(() => {
  useSurfaceDemandStore.setState(useSurfaceDemandStore.getInitialState(), true);
});

afterEach(() => {
  useSurfaceDemandStore.setState(useSurfaceDemandStore.getInitialState(), true);
});

function specRef(id: "spec-a" | "spec-b"): EpicNodeRef {
  return {
    id,
    instanceId: `${id}-instance`,
    type: "spec",
    name: id === "spec-a" ? "Spec A" : "Spec B",
    hostId: "host-a",
  };
}

function chatRef(id: string): EpicNodeRef {
  return {
    id,
    instanceId: `${id}-instance`,
    type: "chat",
    name: id,
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
  const demands: Array<"preview" | "settled" | undefined> = [];
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
      demands.push(intent.demand);
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
      } else if (intent.kind === "home") {
        calls.push({ kind: "home", epicId: null, sectionId: null });
        pathname = "/home";
      } else if (intent.kind === "sample-workspace") {
        calls.push({ kind: "home", epicId: null, sectionId: null });
        pathname = "/sample-workspace";
      } else {
        calls.push({
          kind: "section",
          epicId: null,
          sectionId: intent.section,
        });
        pathname = `/settings/${intent.section}`;
      }
      // Mirrors the real activation authority's synchronous store update, so
      // header tab cycling (which reads live focus, not pathname) sees it.
      synchronizeLayoutForRoute(pathname);
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
  return { router, calls, demands, setPath };
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

    expect(defaults["app.notifications.open"]).toBe("mod+shift+b");
    expect(findActionForChord("mod+shift+b")).toBe("app.notifications.open");
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
    // Getting started leads the list and owns digit 1, so 2 is General.
    expect(fireDigit(router, 2, "alt")).toBe(true);
    expect(calls[0].kind).toBe("section");
    expect(calls[0].sectionId).toBe("general");
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

function paneState(tabId: string): {
  readonly ids: ReadonlyArray<string>;
  readonly activeId: string | null;
} {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  const activePaneId = canvas?.activePaneId ?? null;
  const pane =
    canvas === undefined || activePaneId === null
      ? null
      : findPaneById(canvas.root, activePaneId);
  return {
    ids: pane?.tabInstanceIds ?? [],
    activeId: pane?.activeTabId ?? null,
  };
}

// Physical press commits immediately; held repeats only advance an in-memory
// cursor until flush (the audit's Cmd+Shift+] hold regression).
describe("dispatchKeydownAction tab-cycle repeat coalescing", () => {
  // jsdom has no native requestAnimationFrame; stub one that schedules
  // without firing, so a repeat's scheduling call doesn't throw.
  let rafId = 0;
  const originalRaf = window.requestAnimationFrame;
  const originalCancelRaf = window.cancelAnimationFrame;

  beforeEach(() => {
    window.localStorage.clear();
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
    seedEpicTabs();
    window.requestAnimationFrame = () => ++rafId;
    window.cancelAnimationFrame = () => undefined;
  });

  afterEach(() => {
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    vi.restoreAllMocks();
    window.requestAnimationFrame = originalRaf;
    window.cancelAnimationFrame = originalCancelRaf;
  });

  it("coalesces repeated tab.next presses into a single commit at flush, landing on the final target", () => {
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-pane-cycle", "Pane Cycle");
    // 4 tiles: with press + 2 repeats (3 steps total), start/after-press/final
    // land on 3 distinct indices - a 2-tile pane can alias these under mod 2.
    ["p1", "p2", "p3", "p4"].forEach((id) => {
      useEpicCanvasStore.getState().openTileInTab(tabId, {
        id,
        instanceId: `${id}-instance`,
        type: "spec",
        name: id,
        hostId: "host-a",
      });
    });
    const { router } = buildRouter(`/epics/epic-pane-cycle/${tabId}`);
    const commitSpy = vi.spyOn(
      useEpicCanvasStore.getState(),
      "prepareSetActiveTileTabFocusTarget",
    );
    const paneId =
      useEpicCanvasStore.getState().canvasByTabId[tabId]?.activePaneId;
    if (paneId === undefined || paneId === null) {
      throw new Error("expected an active pane");
    }
    const historyOf = (): ReadonlyArray<string> => {
      const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
      const pane =
        canvas === undefined ? null : findPaneById(canvas.root, paneId);
      return pane?.activationHistory ?? [];
    };

    const start = paneState(tabId);
    if (start.activeId === null) throw new Error("expected an active pane tab");
    const startIndex = start.ids.indexOf(start.activeId);
    const expectedAfter = (steps: number) =>
      start.ids[(startIndex + steps) % start.ids.length];

    // Physical press: commits immediately (1st commit).
    expect(dispatchKeydownAction("tab.next", router, false)).toBe(true);
    expect(paneState(tabId).activeId).toBe(expectedAfter(1));
    expect(commitSpy).toHaveBeenCalledTimes(1);

    // Held repeat 1: cursor moves, no new commit.
    expect(dispatchKeydownAction("tab.next", router, true)).toBe(true);
    expect(paneState(tabId).activeId).toBe(expectedAfter(1));
    expect(commitSpy).toHaveBeenCalledTimes(1);

    // Held repeat 2: cursor moves again, still no new commit.
    expect(dispatchKeydownAction("tab.next", router, true)).toBe(true);
    expect(paneState(tabId).activeId).toBe(expectedAfter(1));
    expect(commitSpy).toHaveBeenCalledTimes(1);

    // A repeat-driven flush (what an rAF tick triggers while still held)
    // previews the target - it moves the pane's visible selection and marks
    // it as preview demand without touching activationHistory, and never
    // calls the real, history-recording commit.
    const historyBeforePreview = historyOf();
    expect(hasPreviewDemand()).toBe(false);
    flushTabCycle(router);
    expect(expectedAfter(3)).not.toBe(expectedAfter(1));
    expect(expectedAfter(3)).not.toBe(start.activeId);
    expect(paneState(tabId).activeId).toBe(expectedAfter(3));
    expect(paneDemand(paneId)).toBe("preview");
    expect(historyOf()).toEqual(historyBeforePreview);
    expect(commitSpy).toHaveBeenCalledTimes(1);

    // Release (what keyup triggers): settles the previewed target through the
    // real, history-recording activation - exactly once, at the final target -
    // and drops the preview demand.
    resetTabCycle(router);
    expect(paneState(tabId).activeId).toBe(expectedAfter(3));
    expect(paneDemand(paneId)).toBe("settled");
    expect(hasPreviewDemand()).toBe(false);
    expect(historyOf()[0]).toBe(expectedAfter(3));
    expect(commitSpy).toHaveBeenCalledTimes(2);
  });

  it("commits a held repeat via the 100ms fallback timer when the animation frame never fires (occluded window)", () => {
    const firstTabId = useEpicCanvasStore.getState().openTabOrder[0];
    const { router, calls, demands } = buildRouter(`/epics/e1/${firstTabId}`);

    vi.useFakeTimers();
    // Simulate an occluded/hidden window: rAF is scheduled but never fires.
    window.requestAnimationFrame = () => 0;
    try {
      expect(dispatchKeydownAction("epic.next", router, false)).toBe(true);
      expect(calls.length).toBe(1);
      expect(calls[0].epicId).toBe("e2");

      expect(dispatchKeydownAction("epic.next", router, true)).toBe(true);
      // The repeat only schedules - no frame ever runs to flush it.
      expect(calls.length).toBe(1);

      vi.advanceTimersByTime(100);
      expect(calls.length).toBe(2);
      expect(calls[1].epicId).toBe("e3");
      // The press activates normally; the scheduled flush only previews.
      expect(demands).toEqual(["settled", "preview"]);
      // A scheduled flush does not settle - only an explicit reset
      // (keyup/pointerdown/etc.) does, and it settles the previewed target.
      resetTabCycle(router);
      expect(demands).toEqual(["settled", "preview", "settled"]);
      expect(calls[2].epicId).toBe("e3");
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates a held repeat when a pane tile actually closes mid-hold (not this dispatch), instead of committing a stale target", () => {
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-pane-close", "Pane Close");
    ["p1", "p2", "p3"].forEach((id) => {
      useEpicCanvasStore.getState().openTileInTab(tabId, {
        id,
        instanceId: `${id}-instance`,
        type: "spec",
        name: id,
        hostId: "host-a",
      });
    });
    const pathname = `/epics/epic-pane-close/${tabId}`;
    const { router } = buildRouter(pathname);
    const before = paneState(tabId);

    expect(dispatchKeydownAction("tab.next", router, false)).toBe(true);
    expect(dispatchKeydownAction("tab.next", router, true)).toBe(true);

    // A different router/window closes the active tile mid-hold - a real
    // membership change, not a mutation of the held session's own router.
    const { router: otherRouter } = buildRouter(pathname);
    expect(dispatchAction("tab.close", otherRouter)).toBe(true);
    const afterClose = paneState(tabId);
    expect(afterClose.ids.length).toBe(before.ids.length - 1);

    flushTabCycle(router);
    expect(paneState(tabId)).toEqual(afterClose);
    resetTabCycle(router);
  });
});

// Owner-boundary coverage: the held-cycle preview `dispatchKeydownAction`
// drives (repeat -> preview, keyup/reset -> real activation) is what
// `retainedPaneChatInstanceIds` reads through `pane.activationHistory` /
// `pane.activeTabId` and the pane's preview demand.
// These tests exercise both real stores together, the way
// `use-mounted-pane-tabs.ts` and `tile-surface-membership.ts` actually call
// them - a bug in either side's contract (dispatch writing history it
// shouldn't, or retention reading a stale/lost signal) would only show up at
// this boundary, not inside either module's own unit tests.
describe("held Cmd+] cycling vs chat retention (owner boundary)", () => {
  let rafId = 0;
  const originalRaf = window.requestAnimationFrame;
  const originalCancelRaf = window.cancelAnimationFrame;

  beforeEach(() => {
    window.localStorage.clear();
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
    seedEpicTabs();
    window.requestAnimationFrame = () => ++rafId;
    window.cancelAnimationFrame = () => undefined;
  });

  afterEach(() => {
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    vi.restoreAllMocks();
    window.requestAnimationFrame = originalRaf;
    window.cancelAnimationFrame = originalCancelRaf;
  });

  function retainedChatsFor(
    tabId: string,
    paneId: string,
  ): ReadonlyArray<string> {
    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    if (canvas === undefined) throw new Error("expected canvas");
    const pane = findPaneById(canvas.root, paneId);
    if (pane === null) throw new Error("expected pane");
    return retainedPaneChatInstanceIds({
      pane,
      cap: RETAINED_PANE_CHAT_CAP,
      demand: paneDemand(paneId),
      tileFor: (instanceId) => canvas.tilesByInstanceId[instanceId],
    });
  }

  function activationHistoryFor(
    tabId: string,
    paneId: string,
  ): ReadonlyArray<string> {
    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    const pane =
      canvas === undefined ? null : findPaneById(canvas.root, paneId);
    return pane?.activationHistory ?? [];
  }

  it("keeps both settled chats retained while a hold previews ten other chats, never growing past the cap", () => {
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-chat-hold", "Chat Hold");
    const chatIds = Array.from(
      { length: 12 },
      (_, index) => `chat${index + 1}`,
    );
    chatIds.forEach((id) => {
      useEpicCanvasStore.getState().openTileInTab(tabId, chatRef(id));
    });
    const paneId =
      useEpicCanvasStore.getState().canvasByTabId[tabId]?.activePaneId;
    if (paneId === undefined || paneId === null) {
      throw new Error("expected an active pane");
    }

    const { router } = buildRouter(`/epics/epic-chat-hold/${tabId}`);

    // Physical press (non-repeat): ordinary activation, same as any single
    // Cmd+]. This is the pair the hold below must never evict.
    expect(dispatchKeydownAction("tab.next", router, false)).toBe(true);
    const settled = retainedChatsFor(tabId, paneId);
    expect(settled).toHaveLength(2);
    const [settledA, settledB] = settled;
    const settledHistory = activationHistoryFor(tabId, paneId);

    // Hold: ten repeats, flushing after each one (an rAF tick per held key),
    // previewing a different chat every time.
    for (let step = 0; step < 10; step++) {
      expect(dispatchKeydownAction("tab.next", router, true)).toBe(true);
      flushTabCycle(router);
      const duringHold = retainedChatsFor(tabId, paneId);
      // The passing preview target takes no slot of its own.
      expect(duringHold).toEqual(settled);
      expect(duringHold).toContain(settledA);
      expect(duringHold).toContain(settledB);
      expect(activationHistoryFor(tabId, paneId)).toEqual(settledHistory);
    }

    resetTabCycle(router);
  });

  it("settles the held-cycle target through real activation on keyup, then retains the target as an ordinary settled chat", () => {
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-chat-settle", "Chat Settle");
    ["chat1", "chat2", "chat3", "chat4"].forEach((id) => {
      useEpicCanvasStore.getState().openTileInTab(tabId, chatRef(id));
    });
    const paneId =
      useEpicCanvasStore.getState().canvasByTabId[tabId]?.activePaneId;
    if (paneId === undefined || paneId === null) {
      throw new Error("expected an active pane");
    }
    const { router } = buildRouter(`/epics/epic-chat-settle/${tabId}`);

    // Physical press: chat4 (last opened, so active) -> chat1 (wrap). Real
    // activation - the settled pair going into the hold is {chat1, chat4}.
    expect(dispatchKeydownAction("tab.next", router, false)).toBe(true);
    expect(retainedChatsFor(tabId, paneId)).toEqual([
      "chat1-instance",
      "chat4-instance",
    ]);
    const settledHistory = activationHistoryFor(tabId, paneId);

    // Hold through chat2, then chat3 - each a preview, never committed.
    expect(dispatchKeydownAction("tab.next", router, true)).toBe(true);
    flushTabCycle(router);
    expect(dispatchKeydownAction("tab.next", router, true)).toBe(true);
    flushTabCycle(router);
    expect(paneDemand(paneId)).toBe("preview");
    expect(retainedChatsFor(tabId, paneId)).toEqual([
      "chat1-instance",
      "chat4-instance",
    ]);

    // Keyup: flush (no-op here, nothing pending) then reset settles chat3.
    // Observe every intermediate state the settle publishes: the tab the pane
    // shows must never be evicted from retention once its demand is settled,
    // and the settled window must never lose its most recent chat.
    const observed: Array<{
      readonly demand: "preview" | "settled";
      readonly active: string | null;
      readonly retained: ReadonlyArray<string>;
    }> = [];
    const record = (): void => {
      const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
      const pane =
        canvas === undefined ? null : findPaneById(canvas.root, paneId);
      observed.push({
        demand: paneDemand(paneId),
        active: pane?.activeTabId ?? null,
        retained: retainedChatsFor(tabId, paneId),
      });
    };
    const unsubscribeCanvas = useEpicCanvasStore.subscribe(record);
    const unsubscribeDemand = useSurfaceDemandStore.subscribe(record);
    flushTabCycle(router);
    resetTabCycle(router);
    unsubscribeCanvas();
    unsubscribeDemand();

    expect(observed.length).toBeGreaterThan(0);
    for (const state of observed) {
      expect(state.retained).toContain("chat1-instance");
      if (state.demand === "settled" && state.active !== null) {
        expect(state.retained).toContain(state.active);
      }
    }

    expect(hasPreviewDemand()).toBe(false);
    expect(activationHistoryFor(tabId, paneId)).toEqual([
      "chat3-instance",
      ...settledHistory.filter((id) => id !== "chat3-instance"),
    ]);
    expect(retainedChatsFor(tabId, paneId)).toEqual([
      "chat3-instance",
      "chat1-instance",
    ]);
  });

  it("a membership change that cancels a held cycle never resurrects its preview target into activation history", () => {
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-chat-cancel", "Chat Cancel");
    ["chat1", "chat2", "chat3", "chat4"].forEach((id) => {
      useEpicCanvasStore.getState().openTileInTab(tabId, chatRef(id));
    });
    const paneId =
      useEpicCanvasStore.getState().canvasByTabId[tabId]?.activePaneId;
    if (paneId === undefined || paneId === null) {
      throw new Error("expected an active pane");
    }
    const pathname = `/epics/epic-chat-cancel/${tabId}`;
    const { router } = buildRouter(pathname);

    // Physical press (chat4 -> chat1), then hold into a preview of chat2 -
    // never committed to activationHistory.
    expect(dispatchKeydownAction("tab.next", router, false)).toBe(true);
    expect(dispatchKeydownAction("tab.next", router, true)).toBe(true);
    flushTabCycle(router);

    // External cancellation: a different router closes the previewed tab
    // (chat2) out from under the held session - a real membership change,
    // not anything this session's own dispatch did.
    const { router: otherRouter } = buildRouter(pathname);
    expect(dispatchAction("tab.close", otherRouter)).toBe(true);
    const afterCloseHistory = activationHistoryFor(tabId, paneId);
    const afterCloseRetained = retainedChatsFor(tabId, paneId);
    expect(afterCloseHistory).not.toContain("chat2-instance");

    // The stale session's own flush must see the membership change and
    // refuse to settle chat2 as a real activation.
    flushTabCycle(router);
    resetTabCycle(router);

    // The aborted cursor releases the preview it owned, so retention returns
    // to the ordinary settled policy instead of staying pinned to a tab that
    // no longer exists.
    expect(paneDemand(paneId)).toBe("settled");
    expect(hasPreviewDemand()).toBe(false);
    expect(activationHistoryFor(tabId, paneId)).toEqual(afterCloseHistory);
    expect(retainedChatsFor(tabId, paneId)).toEqual(afterCloseRetained);
  });
});

function fireWindowKeyboardEvent(
  type: "keydown" | "keyup",
  init: KeyboardEventInit,
): void {
  window.dispatchEvent(
    new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }),
  );
}

function renderHeaderCycleProvider(initialPathname: string): {
  readonly navigateCalls: ReadonlyArray<unknown>;
  readonly pathname: () => string;
} {
  // Mirrors `buildRouter`: seeds the real tabs-store focus to match the
  // initial route, since header cycling reads live focus, not the pathname.
  synchronizeLayoutForRoute(initialPathname);
  const history = createMemoryHistory({ initialEntries: [initialPathname] });
  const navigateCalls: Array<unknown> = [];
  const navigate: KeybindingRouterSource["navigate"] = (
    ...args: Array<unknown>
  ) => {
    navigateCalls.push(args);
    return Promise.resolve();
  };
  const router: KeybindingRouterSource = {
    get state() {
      return { location: { pathname: history.location.pathname } };
    },
    history,
    navigate,
  };
  render(createElement(KeybindingProvider, { router, children: null }));
  return { navigateCalls, pathname: () => history.location.pathname };
}

// Same coalescing, through the real provider's event wiring (keydown/keyup/
// pointerdown/focusin), with a router whose `navigate` never resolves the URL.
describe("<KeybindingProvider /> held-key tab cycling (header)", () => {
  const primaryModifier = isMac() ? { metaKey: true } : { ctrlKey: true };
  const headerNextInit: KeyboardEventInit = {
    code: "BracketRight",
    key: "]",
    shiftKey: true,
    ...primaryModifier,
  };

  // jsdom has no native requestAnimationFrame; stub one that schedules
  // without firing (matches a real browser, which fires on next paint, after
  // this synchronous test already released the key).
  let rafId = 0;
  const originalRaf = window.requestAnimationFrame;
  const originalCancelRaf = window.cancelAnimationFrame;

  beforeEach(() => {
    window.localStorage.clear();
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
    __resetTabNavigationControllerForTesting();
    seedEpicTabs();
    window.requestAnimationFrame = () => ++rafId;
    window.cancelAnimationFrame = () => undefined;
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
    window.requestAnimationFrame = originalRaf;
    window.cancelAnimationFrame = originalCancelRaf;
  });

  it("commits the physical press immediately, then coalesces a held repeat into one commit on keyup, without waiting on the router's own pathname", () => {
    const firstTabId = useEpicCanvasStore.getState().openTabOrder[0];
    const initialPathname = `/epics/e1/${firstTabId}`;
    const { navigateCalls, pathname } =
      renderHeaderCycleProvider(initialPathname);

    act(() => fireWindowKeyboardEvent("keydown", headerNextInit));
    const afterPress = useEpicCanvasStore.getState().activeTabId;
    expect(afterPress).not.toBe(firstTabId);
    expect(navigateCalls.length).toBe(1);
    // `navigate` never resolved the URL - the router's own pathname lags.
    expect(pathname()).toBe(initialPathname);

    act(() =>
      fireWindowKeyboardEvent("keydown", { ...headerNextInit, repeat: true }),
    );
    expect(useEpicCanvasStore.getState().activeTabId).toBe(afterPress);
    expect(navigateCalls.length).toBe(1);

    act(() => fireWindowKeyboardEvent("keyup", headerNextInit));
    expect(useEpicCanvasStore.getState().activeTabId).not.toBe(afterPress);
    expect(navigateCalls.length).toBe(2);
  });

  it("settles a still-owned held preview through the controller when membership changes mid-hold, leaving route, history and demand consistent", () => {
    const [aTabId, bTabId, cTabId] = useEpicCanvasStore.getState().openTabOrder;
    const { navigateCalls } = renderHeaderCycleProvider(`/epics/e1/${aTabId}`);
    vi.useFakeTimers();
    try {
      // Held from a settled A: the first event is a repeat, so B is only a
      // preview - no route write, no history.
      act(() =>
        fireWindowKeyboardEvent("keydown", { ...headerNextInit, repeat: true }),
      );
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(useEpicCanvasStore.getState().activeTabId).toBe(bTabId);
      expect(topLevelDemand(`epic:${bTabId}`)).toBe("preview");
      expect(navigateCalls.length).toBe(0);

      // An unrelated header tab disappears while B is still focused.
      act(() => {
        useTabsStore.setState((state) => ({
          ...state,
          items: state.items.filter(
            (item) => !(item.kind === "tab" && item.ref.id === cTabId),
          ),
          stripOrder: state.stripOrder.filter((ref) => ref.id !== cTabId),
        }));
        window.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      });
      act(() => fireWindowKeyboardEvent("keyup", headerNextInit));
    } finally {
      vi.useRealTimers();
    }

    // The cursor still owned B, so B settles through ordinary activation.
    expect(useEpicCanvasStore.getState().activeTabId).toBe(bTabId);
    expect(hasPreviewDemand()).toBe(false);
    expect(navigateCalls.length).toBe(1);
    const navigateArgs = navigateCalls[0];
    if (!Array.isArray(navigateArgs)) throw new Error("expected navigate args");
    expect(navigateArgs[0]).toMatchObject({ params: { tabId: bTabId } });
    expect(
      tabActivationHistory(useTabsStore.getState()).map(tabRefKey)[0],
    ).toBe(`epic:${bTabId}`);
  });

  it("cancels an in-flight held repeat on pointerdown, before it can commit", () => {
    const firstTabId = useEpicCanvasStore.getState().openTabOrder[0];
    renderHeaderCycleProvider(`/epics/e1/${firstTabId}`);

    act(() => fireWindowKeyboardEvent("keydown", headerNextInit));
    const afterPress = useEpicCanvasStore.getState().activeTabId;

    act(() =>
      fireWindowKeyboardEvent("keydown", { ...headerNextInit, repeat: true }),
    );
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    act(() => fireWindowKeyboardEvent("keyup", headerNextInit));

    expect(useEpicCanvasStore.getState().activeTabId).toBe(afterPress);
  });

  it("cancels a pending held-repeat commit if a blocking dialog opens before the key is released", () => {
    const firstTabId = useEpicCanvasStore.getState().openTabOrder[0];
    renderHeaderCycleProvider(`/epics/e1/${firstTabId}`);

    act(() => fireWindowKeyboardEvent("keydown", headerNextInit));
    const afterPress = useEpicCanvasStore.getState().activeTabId;

    act(() =>
      fireWindowKeyboardEvent("keydown", { ...headerNextInit, repeat: true }),
    );

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-state", "open");
    document.body.append(dialog);

    act(() => fireWindowKeyboardEvent("keyup", headerNextInit));

    expect(useEpicCanvasStore.getState().activeTabId).toBe(afterPress);
  });

  it("never commits a held-repeat cycle onto a header whose live tab order changed underneath it", () => {
    const firstTabId = useEpicCanvasStore.getState().openTabOrder[0];
    renderHeaderCycleProvider(`/epics/e1/${firstTabId}`);

    act(() => fireWindowKeyboardEvent("keydown", headerNextInit));
    const afterPress = useEpicCanvasStore.getState().activeTabId;

    act(() =>
      fireWindowKeyboardEvent("keydown", { ...headerNextInit, repeat: true }),
    );

    // The header's live order changes mid-hold (e.g. a tab reordered
    // elsewhere) without touching which tab is focused.
    act(() => {
      useTabsStore.setState((state) => ({
        ...state,
        stripOrder: [...state.stripOrder].reverse(),
      }));
      window.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    act(() => fireWindowKeyboardEvent("keyup", headerNextInit));

    expect(useEpicCanvasStore.getState().activeTabId).toBe(afterPress);
  });

  it("holds preview demand only between the first committed repeat and the keyup or cancellation that settles it", () => {
    const firstTabId = useEpicCanvasStore.getState().openTabOrder[0];
    renderHeaderCycleProvider(`/epics/e1/${firstTabId}`);
    vi.useFakeTimers();
    try {
      // A single physical press is an ordinary activation: never a preview.
      act(() => fireWindowKeyboardEvent("keydown", headerNextInit));
      const afterPress = useEpicCanvasStore.getState().activeTabId;
      expect(hasPreviewDemand()).toBe(false);

      // Repeats only move the cursor: nothing is previewed until a frame (or
      // the 100ms fallback, since no frame fires here) commits the target.
      act(() =>
        fireWindowKeyboardEvent("keydown", { ...headerNextInit, repeat: true }),
      );
      act(() =>
        fireWindowKeyboardEvent("keydown", { ...headerNextInit, repeat: true }),
      );
      expect(hasPreviewDemand()).toBe(false);
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(hasPreviewDemand()).toBe(true);

      // keyup settles the final target and releases the demand.
      act(() => fireWindowKeyboardEvent("keyup", headerNextInit));
      const afterRelease = useEpicCanvasStore.getState().activeTabId;
      expect(hasPreviewDemand()).toBe(false);
      expect(afterRelease).not.toBe(afterPress);
      expect(topLevelDemand(`epic:${afterRelease}`)).toBe("settled");

      // A second hold, cancelled by pointerdown before it commits, never
      // previews at all and leaves nothing behind.
      act(() => fireWindowKeyboardEvent("keydown", headerNextInit));
      const afterSecondPress = useEpicCanvasStore.getState().activeTabId;
      act(() =>
        fireWindowKeyboardEvent("keydown", { ...headerNextInit, repeat: true }),
      );
      expect(hasPreviewDemand()).toBe(false);

      act(() => {
        window.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true }),
        );
      });
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(hasPreviewDemand()).toBe(false);

      // The cancelled session leaves nothing pending for keyup to flush.
      act(() => fireWindowKeyboardEvent("keyup", headerNextInit));
      expect(useEpicCanvasStore.getState().activeTabId).toBe(afterSecondPress);
      expect(hasPreviewDemand()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// AltGr types a character on Windows/Linux by presenting itself to the event
// as Ctrl+Alt (AltGr+N is a Polish ń, AltGr+2 a German @) - `handleKeyDown`'s
// `event.getModifierState("AltGraph")` guard must return before digit
// matching, chord matching, and any preventDefault/dispatch, so typing is
// never swallowed by an app action or a user's own ctrl+alt rebind.
describe("<KeybindingProvider /> and AltGr (Ctrl+Alt presented as AltGraph)", () => {
  function fireWindowKeyDown(init: KeyboardEventInit): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { cancelable: true, ...init });
    window.dispatchEvent(event);
    return event;
  }

  beforeEach(() => {
    window.localStorage.clear();
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
    __resetTabNavigationControllerForTesting();
    seedEpicTabs();
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    useTabsStore.setState({
      stripOrder: [],
      systemTabs: { history: null, settings: null },
    });
  });

  it("skips tab.split.add's own ctrl+alt+n default under AltGraph", () => {
    const calls: Array<void> = [];
    const unregister = registerDynamicActionHandler("tab.split.add", () => {
      calls.push(undefined);
    });
    render(
      createElement(KeybindingProvider, {
        router: buildProviderRouterSource("/epics/e1"),
        children: null,
      }),
    );
    try {
      let event: KeyboardEvent | undefined;
      act(() => {
        event = fireWindowKeyDown({
          code: "KeyN",
          ctrlKey: true,
          altKey: true,
          modifierAltGraph: true,
        });
      });

      expect(calls.length).toBe(0);
      expect(event?.defaultPrevented).toBe(false);

      // Sanity: the identical chord with no AltGraph dispatches.
      act(() => {
        event = fireWindowKeyDown({
          code: "KeyN",
          ctrlKey: true,
          altKey: true,
        });
      });
      expect(calls.length).toBe(1);
      expect(event?.defaultPrevented).toBe(true);
    } finally {
      unregister();
    }
  });

  it("skips a user's own rebind to another ctrl+alt chord under AltGraph too", () => {
    useKeybindingStore.getState().setBinding("tab.split.add", "ctrl+alt+j");
    const calls: Array<void> = [];
    const unregister = registerDynamicActionHandler("tab.split.add", () => {
      calls.push(undefined);
    });
    render(
      createElement(KeybindingProvider, {
        router: buildProviderRouterSource("/epics/e1"),
        children: null,
      }),
    );
    try {
      let event: KeyboardEvent | undefined;
      act(() => {
        event = fireWindowKeyDown({
          code: "KeyJ",
          ctrlKey: true,
          altKey: true,
          modifierAltGraph: true,
        });
      });

      expect(calls.length).toBe(0);
      expect(event?.defaultPrevented).toBe(false);

      // Sanity: the rebind is live and would fire without AltGraph.
      act(() => {
        event = fireWindowKeyDown({
          code: "KeyJ",
          ctrlKey: true,
          altKey: true,
        });
      });
      expect(calls.length).toBe(1);
      expect(event?.defaultPrevented).toBe(true);
    } finally {
      unregister();
    }
  });

  it("does not let an AltGr digit (ctrl+alt+2) match a digit action", () => {
    // Rebind to the mask ctrl+alt actually reads as off macOS (`ctrl` is
    // `mod` there), so this digit would match if the guard didn't run first.
    useKeybindingStore.getState().setBinding("epic.switch.byDigit", "mod+alt");
    const secondTabId = useEpicCanvasStore.getState().openTabOrder[1];
    render(
      createElement(KeybindingProvider, {
        router: buildProviderRouterSource("/epics/e1"),
        children: null,
      }),
    );

    let event: KeyboardEvent | undefined;
    act(() => {
      event = fireWindowKeyDown({
        code: "Digit2",
        ctrlKey: true,
        altKey: true,
        modifierAltGraph: true,
      });
    });

    expect(event?.defaultPrevented).toBe(false);
    expect(useEpicCanvasStore.getState().activeTabId).not.toBe(secondTabId);

    // Sanity: the rebound mask does match without AltGraph.
    act(() => {
      fireWindowKeyDown({ code: "Digit2", ctrlKey: true, altKey: true });
    });
    expect(useEpicCanvasStore.getState().activeTabId).toBe(secondTabId);
  });
});
