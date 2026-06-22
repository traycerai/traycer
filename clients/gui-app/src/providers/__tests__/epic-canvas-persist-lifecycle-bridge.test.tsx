import "../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { EpicCanvasPersistLifecycleBridge } from "@/providers/epic-canvas-persist-lifecycle-bridge";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { epicCanvasKey } from "@/lib/persist";

interface PersistedEpicCanvasState {
  readonly tabsById: Readonly<
    Record<
      string,
      {
        readonly tabId: string;
        readonly epicId: string;
        readonly name: string;
        readonly canvas: { readonly root: null; readonly activeGroupId: null };
        readonly lastSeenAt: number;
      }
    >
  >;
  readonly openTabOrder: ReadonlyArray<string>;
  readonly activeTabId: string | null;
  readonly mostRecentTabIdByEpicId: Readonly<Record<string, string>>;
  readonly artifactTreeByEpicId: Readonly<
    Record<string, ReadonlyArray<unknown>>
  >;
}

function resetAuth(
  status: "signed-out" | "signing-in" | "signed-in",
  email: string | null,
): void {
  if (status === "signed-in" && email !== null) {
    useAuthStore.setState({
      status,
      profile: { userId: email, userName: email, email },
      contextMetadata: { userId: email, username: email },
    });
    return;
  }
  useAuthStore.setState({ status, profile: null, contextMetadata: null });
}

function resetEpicCanvasStore(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState());
  useEpicCanvasStore.persist.setOptions({ name: epicCanvasKey(null) });
}

function persistSnapshot(
  userId: string | null,
  state: PersistedEpicCanvasState,
): void {
  window.localStorage.setItem(
    epicCanvasKey(userId),
    JSON.stringify({
      state,
      version: 1,
    }),
  );
}

function persistedEpicTab(
  epicId: string,
  tabId: string,
  name: string,
): PersistedEpicCanvasState {
  return {
    tabsById: {
      [tabId]: {
        tabId,
        epicId,
        name,
        canvas: { root: null, activeGroupId: null },
        lastSeenAt: 1,
      },
    },
    openTabOrder: [tabId],
    activeTabId: tabId,
    mostRecentTabIdByEpicId: { [epicId]: tabId },
    artifactTreeByEpicId: { [epicId]: [] },
  };
}

describe("<EpicCanvasPersistLifecycleBridge />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetAuth("signed-out", null);
    resetEpicCanvasStore();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    resetAuth("signed-out", null);
    resetEpicCanvasStore();
  });

  it("starts on the anonymous persist bucket", () => {
    expect(useEpicCanvasStore.persist.getOptions().name).toBe(
      epicCanvasKey(null),
    );
  });

  it("rehydrates the current signed-in bucket on initial mount", async () => {
    persistSnapshot(
      "alice@example.com",
      persistedEpicTab("epic-alice", "tab-alice", "Alice Epic"),
    );
    resetAuth("signed-in", "alice@example.com");

    render(
      <EpicCanvasPersistLifecycleBridge>
        <div />
      </EpicCanvasPersistLifecycleBridge>,
    );

    await waitFor(() => {
      expect(useEpicCanvasStore.persist.getOptions().name).toBe(
        epicCanvasKey("alice@example.com"),
      );
      const state = useEpicCanvasStore.getState();
      expect(state.activeTabId).toBe("tab-alice");
      expect(state.tabsById["tab-alice"]?.tabId).toBe("tab-alice");
      expect(state.tabsById["tab-alice"]?.epicId).toBe("epic-alice");
    });
  });

  it("rehydrates the matching per-user bucket on sign-in and user-switch", async () => {
    persistSnapshot(
      "alice@example.com",
      persistedEpicTab("epic-alice", "tab-alice", "Alice Epic"),
    );
    persistSnapshot(
      "bob@example.com",
      persistedEpicTab("epic-bob", "tab-bob", "Bob Epic"),
    );

    render(
      <EpicCanvasPersistLifecycleBridge>
        <div />
      </EpicCanvasPersistLifecycleBridge>,
    );

    act(() => {
      resetAuth("signed-in", "alice@example.com");
    });

    await waitFor(() => {
      expect(useEpicCanvasStore.persist.getOptions().name).toBe(
        epicCanvasKey("alice@example.com"),
      );
      expect(useEpicCanvasStore.getState().activeTabId).toBe("tab-alice");
      expect(useEpicCanvasStore.getState().openTabOrder).toEqual(["tab-alice"]);
    });

    act(() => {
      resetAuth("signed-in", "bob@example.com");
    });

    await waitFor(() => {
      expect(useEpicCanvasStore.persist.getOptions().name).toBe(
        epicCanvasKey("bob@example.com"),
      );
      expect(useEpicCanvasStore.getState().activeTabId).toBe("tab-bob");
      expect(useEpicCanvasStore.getState().openTabOrder).toEqual(["tab-bob"]);
    });
  });

  it("resets to an empty canvas when the next user has no persisted bucket", async () => {
    persistSnapshot(
      "alice@example.com",
      persistedEpicTab("epic-alice", "tab-alice", "Alice Epic"),
    );

    render(
      <EpicCanvasPersistLifecycleBridge>
        <div />
      </EpicCanvasPersistLifecycleBridge>,
    );

    act(() => {
      resetAuth("signed-in", "alice@example.com");
    });

    await waitFor(() => {
      expect(useEpicCanvasStore.getState().activeTabId).toBe("tab-alice");
      expect(useEpicCanvasStore.getState().openTabOrder).toEqual(["tab-alice"]);
    });

    act(() => {
      resetAuth("signed-in", "bob@example.com");
    });

    await waitFor(() => {
      expect(useEpicCanvasStore.persist.getOptions().name).toBe(
        epicCanvasKey("bob@example.com"),
      );
      expect(useEpicCanvasStore.getState().activeTabId).toBeNull();
      expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]);
    });
  });

  it("clears the current signed-in bucket and falls back to anonymous on sign-out", async () => {
    persistSnapshot(
      "alice@example.com",
      persistedEpicTab("epic-alice", "tab-alice", "Alice Epic"),
    );

    const clearStorageSpy = vi.spyOn(
      useEpicCanvasStore.persist,
      "clearStorage",
    );
    const setOptionsSpy = vi.spyOn(useEpicCanvasStore.persist, "setOptions");

    render(
      <EpicCanvasPersistLifecycleBridge>
        <div />
      </EpicCanvasPersistLifecycleBridge>,
    );

    act(() => {
      resetAuth("signed-in", "alice@example.com");
    });

    await waitFor(() => {
      expect(useEpicCanvasStore.persist.getOptions().name).toBe(
        epicCanvasKey("alice@example.com"),
      );
    });

    clearStorageSpy.mockClear();
    setOptionsSpy.mockClear();

    act(() => {
      resetAuth("signed-out", null);
    });

    await waitFor(() => {
      expect(clearStorageSpy).toHaveBeenCalledTimes(1);
      expect(setOptionsSpy).toHaveBeenCalledWith({ name: epicCanvasKey(null) });
      expect(
        window.localStorage.getItem(epicCanvasKey("alice@example.com")),
      ).toBeNull();
      expect(useEpicCanvasStore.persist.getOptions().name).toBe(
        epicCanvasKey(null),
      );
    });

    expect(clearStorageSpy.mock.invocationCallOrder[0]).toBeLessThan(
      setOptionsSpy.mock.invocationCallOrder[0],
    );

    clearStorageSpy.mockRestore();
    setOptionsSpy.mockRestore();
  });
});
