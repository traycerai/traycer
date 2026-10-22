import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { EpicCanvasPersistLifecycleBridge } from "@/providers/epic-canvas-persist-lifecycle-bridge";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  setEpicCanvasBrowserPersistenceHydrating,
  setEpicCanvasBrowserPersistenceStorage,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
import { openTile } from "@/stores/epics/canvas/actions";
import { createEmptyCanvas } from "@/stores/epics/canvas/canvas-state";
import { serializeEpicCanvasState } from "@/stores/epics/canvas/migrate-canvas";
import type { EpicArtifactRef } from "@/stores/epics/canvas/types";
import { epicCanvasKey } from "@/lib/persist";
import type { DesktopJsonValue } from "@/lib/windows/types";

/**
 * Real Zustand persist and the real bridge over a controlled storage: a read
 * stays pending until the test settles it, and every write is recorded.
 */
const control = vi.hoisted(() => ({
  reads: new Map<
    string,
    { promise: Promise<string | null>; resolve: (value: string | null) => void }
  >(),
  writes: [] as Array<{ name: string; value: string }>,
  removes: [] as string[],
  hydrated: false,
  trace: [] as string[],
}));

vi.mock("@/stores/epics/canvas/canvas-browser-storage", () => ({
  createCanvasBrowserStorage: () => ({
    getItem: (name: string) =>
      control.reads.get(name)?.promise ?? Promise.resolve(null),
    setItem: (name: string, value: string) => {
      control.writes.push({ name, value });
    },
    removeItem: (name: string) => {
      control.removes.push(name);
    },
  }),
}));

vi.mock("@/lib/tab-sync/browser-canvas-hydration", () => ({
  isBrowserCanvasHydrated: () => control.hydrated,
  markBrowserCanvasHydrated: () => {
    control.hydrated = true;
    control.trace.push("hydrated");
  },
  markBrowserCanvasHydrating: () => {
    control.hydrated = false;
    control.trace.push("hydrating");
  },
}));

vi.mock("@/lib/tab-recovery/history", () => ({
  configureTabRecoveryHistory: () => Promise.resolve(),
}));

vi.mock("@/lib/runner-error-toast", () => ({
  toastFromRunnerError: vi.fn(),
}));

const ALICE_EMAIL = "alice@example.com";
const BOB_EMAIL = "bob@example.com";
const ALICE_KEY = epicCanvasKey(`user:${ALICE_EMAIL}`);
const BOB_KEY = epicCanvasKey(`user:${BOB_EMAIL}`);

function holdRead(name: string): (value: string | null) => void {
  let resolve: (value: string | null) => void = () => undefined;
  const promise = new Promise<string | null>((settle) => {
    resolve = settle;
  });
  control.reads.set(name, { promise, resolve });
  return resolve;
}

function signIn(email: string): void {
  const userId = `user:${email}`;
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId, userName: email, email },
    contextMetadata: { userId, username: email },
  });
}

function signOut(): void {
  useAuthStore.setState({
    status: "signed-out",
    profile: null,
    contextMetadata: null,
  });
}

function savedLayout(
  epicId: string,
  tabId: string,
  canvas: DesktopJsonValue | null,
): string {
  return JSON.stringify({
    version: 1,
    state: {
      tabsById: {
        [tabId]: {
          tabId,
          epicId,
          name: tabId,
          canvas: { root: null, activeGroupId: null },
          lastSeenAt: 1,
        },
      },
      canvasByTabId: canvas === null ? {} : { [tabId]: canvas },
      openTabOrder: [tabId],
      activeTabId: tabId,
      mostRecentTabIdByEpicId: { [epicId]: tabId },
      artifactTreeByEpicId: { [epicId]: [] },
    },
  });
}

/** Lets a settled read run through zustand's promise chain and the bridge. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function renderBridge() {
  return render(
    <EpicCanvasPersistLifecycleBridge>
      <div />
    </EpicCanvasPersistLifecycleBridge>,
  );
}

beforeEach(() => {
  control.reads.clear();
  control.writes.length = 0;
  control.removes.length = 0;
  control.trace.length = 0;
  control.hydrated = false;
  signOut();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState());
  useEpicCanvasStore.persist.setOptions({ name: epicCanvasKey(null) });
});

afterEach(() => {
  cleanup();
  signOut();
  setEpicCanvasBrowserPersistenceStorage(null);
  setEpicCanvasBrowserPersistenceHydrating(false);
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState());
  useEpicCanvasStore.persist.setOptions({ name: epicCanvasKey(null) });
});

describe("browser canvas hydration through the lifecycle bridge", () => {
  it("never applies a slow account's layout after the next account has begun, nor opens readiness for it", async () => {
    const resolveAlice = holdRead(ALICE_KEY);
    const resolveBob = holdRead(BOB_KEY);
    renderBridge();
    await waitFor(() => expect(control.hydrated).toBe(true));

    act(() => {
      signIn(ALICE_EMAIL);
    });
    await waitFor(() => expect(control.hydrated).toBe(false));
    act(() => {
      signIn(BOB_EMAIL);
    });

    resolveAlice(savedLayout("epic-alice", "tab-alice", null));
    await flush();

    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]);
    expect(control.hydrated).toBe(false);

    resolveBob(savedLayout("epic-bob", "tab-bob", null));
    await waitFor(() => expect(control.hydrated).toBe(true));
    const state = useEpicCanvasStore.getState();
    expect(Object.keys(state.tabsById)).toEqual(["tab-bob"]);
    expect(state.activeTabId).toBe("tab-bob");
  });

  it("keeps the canvas empty when the account signs out before its saved layout arrives", async () => {
    const resolveAlice = holdRead(ALICE_KEY);
    renderBridge();
    await waitFor(() => expect(control.hydrated).toBe(true));
    act(() => {
      signIn(ALICE_EMAIL);
    });
    await waitFor(() => expect(control.hydrated).toBe(false));

    act(() => {
      signOut();
    });
    await waitFor(() => expect(control.hydrated).toBe(true));
    resolveAlice(savedLayout("epic-alice", "tab-alice", null));
    await flush();

    const state = useEpicCanvasStore.getState();
    expect(state.openTabOrder).toEqual([]);
    expect(state.tabsById).toEqual({});
    expect(useEpicCanvasStore.persist.getOptions().name).toBe(
      epicCanvasKey(null),
    );
    expect(control.hydrated).toBe(true);
  });

  it("writes nothing while a saved layout is pending, across a reset and an account change", async () => {
    const resolveAlice = holdRead(ALICE_KEY);
    const resolveBob = holdRead(BOB_KEY);
    renderBridge();
    await waitFor(() => expect(control.hydrated).toBe(true));
    control.writes.length = 0;

    act(() => {
      signIn(ALICE_EMAIL);
    });
    act(() => {
      signIn(BOB_EMAIL);
    });
    resolveAlice(savedLayout("epic-alice", "tab-alice", null));
    await flush();
    resolveBob(savedLayout("epic-bob", "tab-bob", null));
    await waitFor(() => expect(control.hydrated).toBe(true));

    expect(control.writes).toEqual([]);
  });

  it("restores a pinned HTML version with its manifest exactly as it was saved", async () => {
    const pinned: EpicArtifactRef = {
      id: "page-1",
      instanceId: "inst-1",
      type: "html",
      name: "Page",
      hostId: "host-1",
      htmlVersion: {
        manifest: {
          files: {
            "index.html": {
              sha256: "a".repeat(64),
              byteLength: 12,
              mediaType: "text/html",
            },
            "css/site.css": {
              sha256: "b".repeat(64),
              byteLength: 7,
              mediaType: "text/css",
            },
          },
          capturedAt: 1_700_000_000_000,
        },
        entryPath: "index.html",
        versionNumber: 4,
      },
    };
    const canvas = serializeEpicCanvasState(
      openTile(createEmptyCanvas(), pinned, false, null),
    );
    holdRead(ALICE_KEY)(savedLayout("epic-alice", "tab-alice", canvas));
    renderBridge();
    await waitFor(() => expect(control.hydrated).toBe(true));

    act(() => {
      signIn(ALICE_EMAIL);
    });

    await waitFor(() =>
      expect(useEpicCanvasStore.getState().activeTabId).toBe("tab-alice"),
    );
    const restored =
      useEpicCanvasStore.getState().canvasByTabId["tab-alice"]
        ?.tilesByInstanceId["inst-1"];
    expect(restored).toMatchObject({ htmlVersion: pinned.htmlVersion });
    expect(JSON.stringify(restored)).toContain(
      JSON.stringify(pinned.htmlVersion?.manifest),
    );
    expect(control.writes).toEqual([]);
  });
});
