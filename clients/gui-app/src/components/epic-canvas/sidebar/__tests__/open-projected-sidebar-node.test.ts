import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openProjectedSidebarNodeInTabWhenAvailable } from "../open-projected-sidebar-node";
import type { ProjectedSidebarNodeOpenArgs } from "../open-projected-sidebar-node";
import type { OpenEpicState } from "@/stores/epics/open-epic/store";

const TAB_ID = "tab-1";
const NODE_ID = "artifact-1";
const FALLBACK_HOST_ID = "host-fallback";

// Minimal store state: the resolver only reads chats / tuiAgents / artifacts.
function emptyState(): OpenEpicState {
  return {
    chats: { byId: {} },
    tuiAgents: { byId: {} },
    artifacts: { byId: {} },
  } as never;
}

function stateWithArtifact(): OpenEpicState {
  return {
    chats: { byId: {} },
    tuiAgents: { byId: {} },
    artifacts: {
      byId: {
        [NODE_ID]: { id: NODE_ID, kind: "spec", title: "A spec" },
      },
    },
  } as never;
}

interface FakeStore {
  readonly getState: () => OpenEpicState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly setState: (next: OpenEpicState) => void;
}

function makeFakeStore(initial: OpenEpicState): FakeStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setState: (next: OpenEpicState) => {
      state = next;
      for (const listener of listeners) listener();
    },
  };
}

function makeArgs(
  store: FakeStore,
  overrides: Partial<ProjectedSidebarNodeOpenArgs>,
): ProjectedSidebarNodeOpenArgs {
  return {
    epicHandle: { store } as never,
    tabId: TAB_ID,
    nodeId: NODE_ID,
    fallbackHostId: FALLBACK_HOST_ID,
    openTileInTab: vi.fn(),
    onBeforeOpen: null,
    onOpened: vi.fn(),
    onUnavailable: vi.fn(),
    onCleanup: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("openProjectedSidebarNodeInTabWhenAvailable", () => {
  it("opens synchronously when the node is already projected and returns a no-op cancel", () => {
    const store = makeFakeStore(stateWithArtifact());
    const openTileInTab = vi.fn();
    const onOpened = vi.fn();
    const onUnavailable = vi.fn();

    const cancel = openProjectedSidebarNodeInTabWhenAvailable(
      makeArgs(store, { openTileInTab, onOpened, onUnavailable }),
    );

    expect(openTileInTab).toHaveBeenCalledTimes(1);
    expect(onOpened).toHaveBeenCalledTimes(1);
    expect(onUnavailable).not.toHaveBeenCalled();
    // The no-op cancel must not fire onUnavailable either.
    cancel();
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it("opens once the node projects into the store", () => {
    const store = makeFakeStore(emptyState());
    const openTileInTab = vi.fn();
    const onOpened = vi.fn();
    const onUnavailable = vi.fn();

    openProjectedSidebarNodeInTabWhenAvailable(
      makeArgs(store, { openTileInTab, onOpened, onUnavailable }),
    );
    expect(openTileInTab).not.toHaveBeenCalled();

    store.setState(stateWithArtifact());
    expect(openTileInTab).toHaveBeenCalledTimes(1);
    expect(onOpened).toHaveBeenCalledTimes(1);
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it("fires onUnavailable on the genuine timeout give-up", () => {
    const store = makeFakeStore(emptyState());
    const onUnavailable = vi.fn();
    const onCleanup = vi.fn();

    openProjectedSidebarNodeInTabWhenAvailable(
      makeArgs(store, { onUnavailable, onCleanup }),
    );
    expect(onUnavailable).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(onCleanup).toHaveBeenCalledTimes(1);
  });

  it("caller-cancel is SILENT: no onUnavailable, tears down the wait, notifies onCleanup", () => {
    const store = makeFakeStore(emptyState());
    const openTileInTab = vi.fn();
    const onUnavailable = vi.fn();
    const onCleanup = vi.fn();

    const cancel = openProjectedSidebarNodeInTabWhenAvailable(
      makeArgs(store, { openTileInTab, onUnavailable, onCleanup }),
    );

    cancel();
    // Cancel != "unavailable": no fallback notification fired.
    expect(onUnavailable).not.toHaveBeenCalled();
    // onCleanup was notified with the cancel handle so registries can drop it.
    expect(onCleanup).toHaveBeenCalledTimes(1);
    expect(onCleanup).toHaveBeenCalledWith(cancel);

    // The subscription was torn down: a late projection no longer opens.
    store.setState(stateWithArtifact());
    expect(openTileInTab).not.toHaveBeenCalled();

    // And the timeout no longer fires onUnavailable after cancel.
    vi.advanceTimersByTime(30_000);
    expect(onUnavailable).not.toHaveBeenCalled();
  });
});
