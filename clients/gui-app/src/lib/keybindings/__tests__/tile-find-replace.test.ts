import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultBindings } from "@/lib/keybindings/actions";
import { findConflict } from "@/lib/keybindings/conflicts";
import {
  dispatchAction,
  findActionForChord,
  type KeybindingRouter,
} from "@/lib/keybindings/dispatch";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import {
  useTileFindStore,
  type TileFindAdapter,
  type TileFindCapability,
  type TileFindStateSnapshot,
} from "@/stores/tile-find";

const REPLACE_CAPABILITIES = new Set<TileFindCapability>([
  "find",
  "replace",
  "replaceAll",
]);

function router(): KeybindingRouter {
  return {
    getPathname: () => "/",
    navigateHome: () => undefined,
    navigateSettings: () => undefined,
    navigateToEpic: () => undefined,
    navigateToEpicTab: () => undefined,
    navigateToEpicList: () => undefined,
    navigateSettingsSection: () => undefined,
    navigateToTabIntent: () => undefined,
    goBack: () => undefined,
    goForward: () => undefined,
    isHistoryNavAvailable: () => false,
    canGoBack: () => false,
    canGoForward: () => false,
  };
}

function snapshot(): TileFindStateSnapshot {
  return {
    requestId: 0,
    status: "idle",
    capabilities: REPLACE_CAPABILITIES,
    query: "",
    matchCase: false,
    replaceText: "",
    current: 0,
    total: 0,
    coverageMessage: null,
    errorMessage: null,
    activeUnitId: null,
    exactHighlight: "none",
  };
}

function adapter(tileInstanceId: string): TileFindAdapter {
  const listeners = new Set<() => void>();
  return {
    tileInstanceId,
    tileKind: "spec",
    getSnapshot: snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    search: vi.fn(),
    next: vi.fn(),
    previous: vi.fn(),
    clear: vi.fn(),
    replace: {
      replaceCurrent: vi.fn(),
      replaceAll: vi.fn(),
    },
  };
}

function registerTileFindTarget(tileInstanceId: string): void {
  useTileFindStore.getState().registerTarget({
    tileInstanceId,
    contentId: `${tileInstanceId}-content`,
    viewTabId: "view-1",
    tileId: `${tileInstanceId}-pane`,
    epicId: "epic-1",
    tileKind: "spec",
    isEligible: true,
    adapter: adapter(tileInstanceId),
  });
}

describe("tile find replace keybinding", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
  });

  afterEach(() => {
    useTileFindStore.getState().resetForTests();
  });

  it("registers mod+alt+f as a conflict-visible action", () => {
    const bindings = getDefaultBindings();

    expect(bindings["tile.find.replace"]).toBe("mod+alt+f");
    expect(findActionForChord("mod+alt+f")).toBe("tile.find.replace");

    const conflict = findConflict(bindings, "epic.new", "mod+alt+f", []);
    expect(conflict?.severity).toBe("duplicate");
    expect(conflict?.conflictingActionId).toBe("tile.find.replace");
  });

  it("opens the active tile find bar with replace expanded", () => {
    registerTileFindTarget("active-tile");

    expect(dispatchAction("tile.find.replace", router())).toBe(true);

    const ui = useTileFindStore.getState().uiByTileInstanceId["active-tile"];
    expect(ui?.isOpen).toBe(true);
    expect(ui?.replaceExpanded).toBe(true);
  });
});
