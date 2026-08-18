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

const ALICE_EMAIL = "alice@example.com";
const BOB_EMAIL = "bob@example.com";
const ALICE_ID = `user:${ALICE_EMAIL}`;
const BOB_ID = `user:${BOB_EMAIL}`;

function resetAuth(
  status: "signed-out" | "signing-in" | "signed-in",
  email: string | null,
): void {
  if (status === "signed-in" && email !== null) {
    // userId and email deliberately DIFFER: a fixture that equates them
    // cannot detect email-keyed scoping.
    const userId = `user:${email}`;
    useAuthStore.setState({
      status,
      profile: { userId, userName: email, email },
      contextMetadata: { userId, username: email },
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
  bucketIdentity: string | null,
  state: PersistedEpicCanvasState,
): void {
  window.localStorage.setItem(
    epicCanvasKey(bucketIdentity),
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

  it("adopts the legacy email-keyed bucket into the signed-in user's canonical bucket on initial mount", async () => {
    // Seeds ONLY the legacy (email-keyed) bucket, so a successful load can
    // only be explained by the one-shot adoption path onto the userId key.
    persistSnapshot(
      ALICE_EMAIL,
      persistedEpicTab("epic-alice", "tab-alice", "Alice Epic"),
    );
    resetAuth("signed-in", ALICE_EMAIL);

    render(
      <EpicCanvasPersistLifecycleBridge>
        <div />
      </EpicCanvasPersistLifecycleBridge>,
    );

    await waitFor(() => {
      expect(useEpicCanvasStore.persist.getOptions().name).toBe(
        epicCanvasKey(ALICE_ID),
      );
      const state = useEpicCanvasStore.getState();
      expect(state.activeTabId).toBe("tab-alice");
      expect(state.tabsById["tab-alice"]?.tabId).toBe("tab-alice");
      expect(state.tabsById["tab-alice"]?.epicId).toBe("epic-alice");
    });
  });

  it("rehydrates the matching per-user bucket on sign-in and user-switch", async () => {
    persistSnapshot(
      ALICE_ID,
      persistedEpicTab("epic-alice", "tab-alice", "Alice Epic"),
    );
    persistSnapshot(
      BOB_ID,
      persistedEpicTab("epic-bob", "tab-bob", "Bob Epic"),
    );

    render(
      <EpicCanvasPersistLifecycleBridge>
        <div />
      </EpicCanvasPersistLifecycleBridge>,
    );

    act(() => {
      resetAuth("signed-in", ALICE_EMAIL);
    });

    await waitFor(() => {
      expect(useEpicCanvasStore.persist.getOptions().name).toBe(
        epicCanvasKey(ALICE_ID),
      );
      expect(useEpicCanvasStore.getState().activeTabId).toBe("tab-alice");
      expect(useEpicCanvasStore.getState().openTabOrder).toEqual(["tab-alice"]);
    });

    act(() => {
      resetAuth("signed-in", BOB_EMAIL);
    });

    await waitFor(() => {
      expect(useEpicCanvasStore.persist.getOptions().name).toBe(
        epicCanvasKey(BOB_ID),
      );
      expect(useEpicCanvasStore.getState().activeTabId).toBe("tab-bob");
      expect(useEpicCanvasStore.getState().openTabOrder).toEqual(["tab-bob"]);
    });
  });

  it("resets to an empty canvas when the next user has no persisted bucket", async () => {
    persistSnapshot(
      ALICE_ID,
      persistedEpicTab("epic-alice", "tab-alice", "Alice Epic"),
    );

    render(
      <EpicCanvasPersistLifecycleBridge>
        <div />
      </EpicCanvasPersistLifecycleBridge>,
    );

    act(() => {
      resetAuth("signed-in", ALICE_EMAIL);
    });

    await waitFor(() => {
      expect(useEpicCanvasStore.getState().activeTabId).toBe("tab-alice");
      expect(useEpicCanvasStore.getState().openTabOrder).toEqual(["tab-alice"]);
    });

    act(() => {
      resetAuth("signed-in", BOB_EMAIL);
    });

    await waitFor(() => {
      expect(useEpicCanvasStore.persist.getOptions().name).toBe(
        epicCanvasKey(BOB_ID),
      );
      expect(useEpicCanvasStore.getState().activeTabId).toBeNull();
      expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]);
    });
  });

  it("clears the current signed-in bucket and falls back to anonymous on sign-out", async () => {
    persistSnapshot(
      ALICE_ID,
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
      resetAuth("signed-in", ALICE_EMAIL);
    });

    await waitFor(() => {
      expect(useEpicCanvasStore.persist.getOptions().name).toBe(
        epicCanvasKey(ALICE_ID),
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
      expect(window.localStorage.getItem(epicCanvasKey(ALICE_ID))).toBeNull();
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
