import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultBindings } from "@/lib/keybindings/actions";
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

const FIND_CAPABILITIES = new Set<TileFindCapability>(["find"]);

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
    capabilities: FIND_CAPABILITIES,
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

function registerTileFindTarget(target: TileFindAdapter): void {
  useTileFindStore.getState().registerTarget({
    tileInstanceId: target.tileInstanceId,
    contentId: `${target.tileInstanceId}-content`,
    viewTabId: "view-1",
    tileId: `${target.tileInstanceId}-pane`,
    epicId: "epic-1",
    tileKind: "spec",
    isEligible: true,
    adapter: target,
  });
}

describe("tile find open and next keybindings", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
  });

  afterEach(() => {
    useTileFindStore.getState().resetForTests();
  });

  it("binds mod+f to open and mod+g to next", () => {
    expect(findActionForChord("mod+f")).toBe("tile.find.open");
    expect(findActionForChord("mod+g")).toBe("tile.find.next");
  });

  it("opens the active tile find bar", () => {
    registerTileFindTarget(adapter("active-tile"));

    expect(dispatchAction("tile.find.open", router())).toBe(true);

    expect(
      useTileFindStore.getState().uiByTileInstanceId["active-tile"]?.isOpen,
    ).toBe(true);
  });

  it("advances to the next match in the active tile", () => {
    const next = vi.fn();
    const target: TileFindAdapter = { ...adapter("active-tile"), next };
    registerTileFindTarget(target);

    expect(dispatchAction("tile.find.next", router())).toBe(true);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("does nothing when no tile can be searched", () => {
    expect(dispatchAction("tile.find.open", router())).toBe(false);
  });
});
