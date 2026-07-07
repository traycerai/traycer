import "../../../../__tests__/test-browser-apis";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import * as Y from "yjs";
import { QuitInterceptBridge } from "@/components/layout/bridges/quit-intercept-bridge";
import {
  setActiveDesktopPerWindowProjectionBridge,
  type DesktopPerWindowProjectionBridge,
} from "@/lib/windows/per-window-projection-debounce";
import { appLogger } from "@/lib/logger";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";

interface RunnerHostOnWindow {
  runnerHost?: unknown;
}
type HandleStore = OpenEpicStoreHandle["store"];
type QuitDecision = "proceed" | "userConfirmedDiscard";
type QuitDecisionPayload =
  | QuitDecision
  | { readonly requestId: string; readonly decision: QuitDecision };

/**
 * Minimal state slice exercised by the quit-intercept bridge and the
 * registry's `getUnsyncedEdits()` aggregator. Everything else defaults to
 * values that will never be read in this test.
 */
interface FakeSessionState {
  isDirty: boolean;
  unsyncedQueueSize: number;
  snapshotMeta: { epicLight: { title: string } | null } | null;
  discardUnsyncedEdits: () => void;
}

interface FakeHandle extends OpenEpicStoreHandle {
  setDirty(isDirty: boolean, queueSize: number): void;
  discardCalls: number;
}

function buildHandle(epicId: string, title: string): FakeHandle {
  const doc = new Y.Doc();
  doc.getMap("epic").set("title", title);
  const subscribers = new Set<() => void>();
  const state: FakeSessionState = {
    isDirty: false,
    unsyncedQueueSize: 0,
    snapshotMeta: { epicLight: { title } },
    discardUnsyncedEdits: () => {
      handle.discardCalls += 1;
      state.isDirty = false;
      state.unsyncedQueueSize = 0;
      for (const s of subscribers) s();
    },
  };
  const storeCallable = (_selector: unknown): unknown => state;
  const storeBase: unknown = Object.assign(storeCallable, {
    getState: () => state as never,
    setState: () => undefined,
    subscribe: (listener: () => void) => {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    getInitialState: () => state as never,
    destroy: () => undefined,
  });
  const store = storeBase as HandleStore;
  const handle: FakeHandle = {
    epicId,
    userId: null,
    doc,
    awareness: {} as never,
    store,
    dispose: () => undefined,
    requestFreshSnapshot: () => undefined,
    isClean: () => !state.isDirty,
    setDirty: (isDirty, queueSize) => {
      state.isDirty = isDirty;
      state.unsyncedQueueSize = queueSize;
      for (const s of subscribers) s();
    },
    discardCalls: 0,
  };
  return handle;
}

interface FreshRequest {
  readonly requestId: string;
}

interface FreshReply {
  readonly requestId: string;
  readonly snapshot: ReadonlyArray<unknown>;
}

interface AppLifecycleFake {
  setUnsyncedEditsSnapshot: MockInstance<
    (snapshot: ReadonlyArray<unknown>) => Promise<void>
  >;
  acknowledgeQuitRequest: MockInstance<(requestId: string) => Promise<void>>;
  respondToQuitRequest: MockInstance<
    (decision: QuitDecisionPayload) => Promise<void>
  >;
  onQuitRequested: MockInstance<
    (handler: (request: unknown) => void) => {
      dispose: () => void;
    }
  >;
  onGetFreshUnsyncedSnapshot: MockInstance<
    (handler: (request: FreshRequest) => void) => {
      dispose: () => void;
    }
  >;
  respondFreshUnsyncedSnapshot: MockInstance<
    (reply: FreshReply) => Promise<void>
  >;
  emitQuitRequest: (request: unknown) => void;
  emitFreshQuery: (request: FreshRequest) => void;
}

interface LegacyAppLifecycleFake {
  setUnsyncedEditsSnapshot: MockInstance<
    (snapshot: ReadonlyArray<unknown>) => Promise<void>
  >;
  respondToQuitRequest: MockInstance<
    (decision: QuitDecisionPayload) => Promise<void>
  >;
  onQuitRequested: MockInstance<
    (handler: (request: unknown) => void) => {
      dispose: () => void;
    }
  >;
  emitQuitRequest: (request: unknown) => void;
}

function installAppLifecycleFake(): AppLifecycleFake {
  let emitQuit: ((request: unknown) => void) | null = null;
  let emitFresh: ((request: FreshRequest) => void) | null = null;
  const fake: AppLifecycleFake = {
    setUnsyncedEditsSnapshot: vi.fn(() => Promise.resolve()),
    acknowledgeQuitRequest: vi.fn(() => Promise.resolve()),
    respondToQuitRequest: vi.fn(() => Promise.resolve()),
    onQuitRequested: vi.fn((handler) => {
      emitQuit = handler;
      return {
        dispose: () => {
          emitQuit = null;
        },
      };
    }),
    onGetFreshUnsyncedSnapshot: vi.fn((handler) => {
      emitFresh = handler;
      return {
        dispose: () => {
          emitFresh = null;
        },
      };
    }),
    respondFreshUnsyncedSnapshot: vi.fn(() => Promise.resolve()),
    emitQuitRequest: (request) => {
      if (emitQuit === null) throw new Error("no quit-request subscriber");
      emitQuit(request);
    },
    emitFreshQuery: (request) => {
      if (emitFresh === null) throw new Error("no fresh-query subscriber");
      emitFresh(request);
    },
  };
  const windowHost = window as WindowMutable;
  windowHost.runnerHost = {
    appLifecycle: {
      setUnsyncedEditsSnapshot: fake.setUnsyncedEditsSnapshot,
      acknowledgeQuitRequest: fake.acknowledgeQuitRequest,
      respondToQuitRequest: fake.respondToQuitRequest,
      onQuitRequested: fake.onQuitRequested,
      onGetFreshUnsyncedSnapshot: fake.onGetFreshUnsyncedSnapshot,
      respondFreshUnsyncedSnapshot: fake.respondFreshUnsyncedSnapshot,
    },
  };
  return fake;
}

function installLegacyAppLifecycleFake(): LegacyAppLifecycleFake {
  let emitQuit: ((request: unknown) => void) | null = null;
  const fake: LegacyAppLifecycleFake = {
    setUnsyncedEditsSnapshot: vi.fn(() => Promise.resolve()),
    respondToQuitRequest: vi.fn(() => Promise.resolve()),
    onQuitRequested: vi.fn((handler) => {
      emitQuit = handler;
      return {
        dispose: () => {
          emitQuit = null;
        },
      };
    }),
    emitQuitRequest: (snapshot) => {
      if (emitQuit === null) throw new Error("no quit-request subscriber");
      emitQuit(snapshot);
    },
  };
  const windowHost = window as WindowMutable;
  windowHost.runnerHost = {
    appLifecycle: {
      setUnsyncedEditsSnapshot: fake.setUnsyncedEditsSnapshot,
      respondToQuitRequest: fake.respondToQuitRequest,
      onQuitRequested: fake.onQuitRequested,
    },
  };
  return fake;
}

type WindowMutable = Window & RunnerHostOnWindow;

function clearRegistry(): void {
  __getOpenEpicRegistryForTests().disposeAll();
}

function clearRunnerHost(): void {
  const windowHost = window as WindowMutable;
  delete windowHost.runnerHost;
}

describe("QuitInterceptBridge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearRegistry();
    clearRunnerHost();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    clearRegistry();
    clearRunnerHost();
    setActiveDesktopPerWindowProjectionBridge(null);
  });

  it("is a no-op when window.runnerHost.appLifecycle is undefined", () => {
    // No runner host installed - rendering must not throw and must not emit
    // a dialog even if there are unsynced edits in the registry.
    const registry = __getOpenEpicRegistryForTests();
    const handle = buildHandle("e1", "Epic One");
    registry.acquire("e1", () => handle);
    handle.setDirty(true, 3);

    render(<QuitInterceptBridge />);
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(screen.queryByTestId("quit-intercept-dialog")).toBeNull();
  });

  it("pushes the current registry snapshot to main on mount and on changes (debounced)", () => {
    const fake = installAppLifecycleFake();
    const registry = __getOpenEpicRegistryForTests();
    const handleA = buildHandle("eA", "Alpha");
    const handleB = buildHandle("eB", "Beta");
    registry.acquire("eA", () => handleA);
    registry.acquire("eB", () => handleB);
    handleA.setDirty(true, 0);

    render(<QuitInterceptBridge />);

    // Debounce window has not elapsed yet.
    expect(fake.setUnsyncedEditsSnapshot).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(fake.setUnsyncedEditsSnapshot).toHaveBeenCalledTimes(1);
    expect(fake.setUnsyncedEditsSnapshot.mock.calls[0][0]).toEqual([
      { epicId: "eA", title: "Alpha", queueSize: 0, isDirty: true },
    ]);

    // A subsequent change triggers another debounced push.
    act(() => {
      handleB.setDirty(true, 1);
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(fake.setUnsyncedEditsSnapshot).toHaveBeenCalledTimes(2);
    const latest = fake.setUnsyncedEditsSnapshot.mock.calls[1][0];
    expect(latest).toEqual([
      { epicId: "eA", title: "Alpha", queueSize: 0, isDirty: true },
      { epicId: "eB", title: "Beta", queueSize: 1, isDirty: true },
    ]);
  });

  it("renders the quit dialog with the correct copy and epic titles on quitRequested", () => {
    const fake = installAppLifecycleFake();
    const registry = __getOpenEpicRegistryForTests();
    const handleA = buildHandle("eA", "Alpha");
    const handleB = buildHandle("eB", "Beta");
    registry.acquire("eA", () => handleA);
    registry.acquire("eB", () => handleB);
    handleA.setDirty(true, 2);
    handleB.setDirty(true, 1);

    render(<QuitInterceptBridge />);

    act(() => {
      fake.emitQuitRequest([
        { epicId: "eA", title: "Alpha", queueSize: 2 },
        { epicId: "eB", title: "Beta", queueSize: 1 },
      ]);
    });

    expect(screen.getByText("Saving - please wait")).not.toBeNull();
    expect(
      screen.getByText(
        "2 Epic(s) have unsynced changes. Wait for them to sync, or quit and discard.",
      ),
    ).not.toBeNull();

    const list = screen.getByTestId("quit-intercept-epic-list");
    expect(list.textContent).toContain("Alpha");
    expect(list.textContent).toContain("Beta");
  });

  it("acknowledges serviced quit requests and responds with the active request id across retries", () => {
    const fake = installAppLifecycleFake();
    const registry = __getOpenEpicRegistryForTests();
    const handleA = buildHandle("eA", "Alpha");
    registry.acquire("eA", () => handleA);
    handleA.setDirty(true, 2);

    render(<QuitInterceptBridge />);

    act(() => {
      fake.emitQuitRequest({
        requestId: "quit-1",
        snapshot: [{ epicId: "eA", title: "Alpha", queueSize: 2 }],
      });
    });
    act(() => {
      fake.emitQuitRequest({
        requestId: "quit-2",
        snapshot: [{ epicId: "eA", title: "Alpha", queueSize: 2 }],
      });
    });

    expect(fake.acknowledgeQuitRequest).toHaveBeenCalledTimes(2);
    expect(fake.acknowledgeQuitRequest).toHaveBeenNthCalledWith(1, "quit-1");
    expect(fake.acknowledgeQuitRequest).toHaveBeenNthCalledWith(2, "quit-2");

    act(() => {
      fireEvent.click(screen.getByTestId("quit-intercept-discard"));
    });

    expect(fake.respondToQuitRequest).toHaveBeenCalledTimes(1);
    expect(fake.respondToQuitRequest).toHaveBeenCalledWith({
      requestId: "quit-2",
      decision: "userConfirmedDiscard",
    });
    expect(screen.queryByTestId("quit-intercept-dialog")).toBeNull();
  });

  it("Wait keeps the dialog open until every session drains, then auto-responds proceed", () => {
    const fake = installAppLifecycleFake();
    const registry = __getOpenEpicRegistryForTests();
    const handleA = buildHandle("eA", "Alpha");
    registry.acquire("eA", () => handleA);
    handleA.setDirty(true, 3);

    render(<QuitInterceptBridge />);

    act(() => {
      fake.emitQuitRequest([{ epicId: "eA", title: "Alpha", queueSize: 3 }]);
    });

    expect(screen.getByTestId("quit-intercept-dialog")).not.toBeNull();
    expect(fake.respondToQuitRequest).not.toHaveBeenCalled();

    act(() => {
      fireEvent.click(screen.getByTestId("quit-intercept-wait"));
    });
    expect(screen.getByTestId("quit-intercept-dialog")).not.toBeNull();
    expect(fake.respondToQuitRequest).not.toHaveBeenCalled();

    // A partial drain must NOT dismiss the dialog.
    act(() => {
      handleA.setDirty(true, 1);
    });
    expect(screen.queryByTestId("quit-intercept-dialog")).not.toBeNull();
    expect(fake.respondToQuitRequest).not.toHaveBeenCalled();

    // Once the registry's unsynced map is empty, auto-proceed fires.
    act(() => {
      handleA.setDirty(false, 0);
    });

    expect(fake.respondToQuitRequest).toHaveBeenCalledTimes(1);
    expect(fake.respondToQuitRequest).toHaveBeenCalledWith("proceed");
    expect(screen.queryByTestId("quit-intercept-dialog")).toBeNull();
  });

  it("Quit and discard drops in-memory edits for every dirty session and responds userConfirmedDiscard", () => {
    const fake = installAppLifecycleFake();
    const registry = __getOpenEpicRegistryForTests();
    const handleA = buildHandle("eA", "Alpha");
    const handleB = buildHandle("eB", "Beta");
    registry.acquire("eA", () => handleA);
    registry.acquire("eB", () => handleB);
    handleA.setDirty(true, 4);
    handleB.setDirty(true, 2);

    render(<QuitInterceptBridge />);

    act(() => {
      fake.emitQuitRequest([
        { epicId: "eA", title: "Alpha", queueSize: 4 },
        { epicId: "eB", title: "Beta", queueSize: 2 },
      ]);
    });

    const discardButton = screen.getByTestId("quit-intercept-discard");
    act(() => {
      fireEvent.click(discardButton);
    });

    expect(handleA.discardCalls).toBe(1);
    expect(handleB.discardCalls).toBe(1);
    expect(fake.respondToQuitRequest).toHaveBeenCalledTimes(1);
    expect(fake.respondToQuitRequest).toHaveBeenCalledWith(
      "userConfirmedDiscard",
    );
    expect(screen.queryByTestId("quit-intercept-dialog")).toBeNull();
  });

  it("Quit and discard still works after clicking Wait first", () => {
    const fake = installAppLifecycleFake();
    const registry = __getOpenEpicRegistryForTests();
    const handleA = buildHandle("eA", "Alpha");
    const handleB = buildHandle("eB", "Beta");
    registry.acquire("eA", () => handleA);
    registry.acquire("eB", () => handleB);
    handleA.setDirty(true, 4);
    handleB.setDirty(true, 2);

    render(<QuitInterceptBridge />);

    act(() => {
      fake.emitQuitRequest([
        { epicId: "eA", title: "Alpha", queueSize: 4 },
        { epicId: "eB", title: "Beta", queueSize: 2 },
      ]);
    });

    act(() => {
      fireEvent.click(screen.getByTestId("quit-intercept-wait"));
    });
    expect(screen.getByTestId("quit-intercept-dialog")).not.toBeNull();
    expect(fake.respondToQuitRequest).not.toHaveBeenCalled();

    act(() => {
      fireEvent.click(screen.getByTestId("quit-intercept-discard"));
    });

    expect(handleA.discardCalls).toBe(1);
    expect(handleB.discardCalls).toBe(1);
    expect(fake.respondToQuitRequest).toHaveBeenCalledTimes(1);
    expect(fake.respondToQuitRequest).toHaveBeenCalledWith(
      "userConfirmedDiscard",
    );
    expect(screen.queryByTestId("quit-intercept-dialog")).toBeNull();
  });

  it("replies to fresh-snapshot queries from the live registry and cancels the ambient debounce", async () => {
    const fake = installAppLifecycleFake();
    const registry = __getOpenEpicRegistryForTests();
    const handleA = buildHandle("eA", "Alpha");
    const handleB = buildHandle("eB", "Beta");
    registry.acquire("eA", () => handleA);
    registry.acquire("eB", () => handleB);
    handleA.setDirty(true, 4);

    render(<QuitInterceptBridge />);

    // A fresh query arrives before the ambient debounce fires.
    act(() => {
      fake.emitFreshQuery({ requestId: "req-42" });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(fake.respondFreshUnsyncedSnapshot).toHaveBeenCalledTimes(1);
    const reply = fake.respondFreshUnsyncedSnapshot.mock.calls[0][0];
    expect(reply.requestId).toBe("req-42");
    expect(reply.snapshot).toEqual([
      { epicId: "eA", title: "Alpha", queueSize: 4, isDirty: true },
    ]);

    // The in-flight ambient debounce was cancelled - advancing past the
    // debounce window MUST NOT fire a `setUnsyncedEditsSnapshot` push.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(fake.setUnsyncedEditsSnapshot).not.toHaveBeenCalled();
  });

  it("defers the fresh-snapshot reply until the per-window projection flush has landed in main", async () => {
    // The quit intercept must not answer main until the debounced per-window
    // projection (tabs/canvas/drafts) has been flushed to main, so main's
    // subsequent `desktopStateStore.flush()` persists the latest layout.
    const fake = installAppLifecycleFake();
    const registry = __getOpenEpicRegistryForTests();
    const handleA = buildHandle("eA", "Alpha");
    registry.acquire("eA", () => handleA);
    handleA.setDirty(true, 4);

    let resolveFlush: (() => void) | null = null;
    const flushBridge: DesktopPerWindowProjectionBridge = {
      update: () => Promise.resolve(),
      flush: () =>
        new Promise<void>((resolve) => {
          resolveFlush = resolve;
        }),
      dispose: () => undefined,
    };
    setActiveDesktopPerWindowProjectionBridge(flushBridge);

    render(<QuitInterceptBridge />);

    act(() => {
      fake.emitFreshQuery({ requestId: "req-flush" });
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Flush still pending -> the reply must NOT have gone out yet.
    expect(fake.respondFreshUnsyncedSnapshot).not.toHaveBeenCalled();

    await act(async () => {
      resolveFlush?.();
      await Promise.resolve();
    });

    expect(fake.respondFreshUnsyncedSnapshot).toHaveBeenCalledTimes(1);
    expect(fake.respondFreshUnsyncedSnapshot.mock.calls[0][0].requestId).toBe(
      "req-flush",
    );
  });

  it("still replies to the fresh-snapshot query when the projection flush rejects", async () => {
    // A failed projection write must not make main wait out its fresh-snapshot
    // timeout and fall back to stale state - the reply still goes out.
    const fake = installAppLifecycleFake();
    const registry = __getOpenEpicRegistryForTests();
    const handleA = buildHandle("eA", "Alpha");
    registry.acquire("eA", () => handleA);
    handleA.setDirty(true, 4);

    const flushBridge: DesktopPerWindowProjectionBridge = {
      update: () => Promise.resolve(),
      flush: () => Promise.reject(new Error("projection flush failed")),
      dispose: () => undefined,
    };
    setActiveDesktopPerWindowProjectionBridge(flushBridge);

    render(<QuitInterceptBridge />);

    act(() => {
      fake.emitFreshQuery({ requestId: "req-reject" });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fake.respondFreshUnsyncedSnapshot).toHaveBeenCalledTimes(1);
    expect(fake.respondFreshUnsyncedSnapshot.mock.calls[0][0].requestId).toBe(
      "req-reject",
    );
  });

  it("does not leave an unhandled rejection when the fresh-snapshot reply IPC itself rejects", async () => {
    // `respondFreshUnsyncedSnapshot` is an `ipcRenderer.invoke` that can
    // reject (main handler removed / sender gone). The response chain must
    // terminate in a `.catch` rather than surfacing an unhandled rejection.
    const errorSpy = vi
      .spyOn(appLogger, "error")
      .mockImplementation(() => undefined);
    const fake = installAppLifecycleFake();
    fake.respondFreshUnsyncedSnapshot.mockImplementation(() =>
      Promise.reject(new Error("ipc channel closed")),
    );
    const registry = __getOpenEpicRegistryForTests();
    const handleA = buildHandle("eA", "Alpha");
    registry.acquire("eA", () => handleA);
    handleA.setDirty(true, 4);

    render(<QuitInterceptBridge />);

    act(() => {
      fake.emitFreshQuery({ requestId: "req-ipc-rejects" });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(errorSpy).toHaveBeenCalledWith(
      "[quit-intercept] fresh-snapshot reply failed",
      { requestId: "req-ipc-rejects" },
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it("preserves quit interception when the desktop bridge has not added fresh-query hooks yet", () => {
    const fake = installLegacyAppLifecycleFake();
    const registry = __getOpenEpicRegistryForTests();
    const handleA = buildHandle("eA", "Alpha");
    registry.acquire("eA", () => handleA);
    handleA.setDirty(true, 2);

    render(<QuitInterceptBridge />);

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(fake.setUnsyncedEditsSnapshot).toHaveBeenCalledWith([
      { epicId: "eA", title: "Alpha", queueSize: 2, isDirty: true },
    ]);

    act(() => {
      fake.emitQuitRequest([{ epicId: "eA", title: "Alpha", queueSize: 2 }]);
    });
    expect(screen.getByTestId("quit-intercept-dialog")).not.toBeNull();

    act(() => {
      fireEvent.click(screen.getByTestId("quit-intercept-discard"));
    });

    expect(handleA.discardCalls).toBe(1);
    expect(fake.respondToQuitRequest).toHaveBeenCalledWith(
      "userConfirmedDiscard",
    );
    expect(screen.queryByTestId("quit-intercept-dialog")).toBeNull();
  });

  it("Escape does not dismiss the dialog or resolve quit while waiting", () => {
    const fake = installAppLifecycleFake();
    const registry = __getOpenEpicRegistryForTests();
    const handleA = buildHandle("eA", "Alpha");
    registry.acquire("eA", () => handleA);
    handleA.setDirty(true, 2);

    render(<QuitInterceptBridge />);

    act(() => {
      fake.emitQuitRequest([{ epicId: "eA", title: "Alpha", queueSize: 2 }]);
    });

    act(() => {
      fireEvent.click(screen.getByTestId("quit-intercept-wait"));
    });

    act(() => {
      fireEvent.keyDown(screen.getByTestId("quit-intercept-dialog"), {
        key: "Escape",
        code: "Escape",
      });
    });

    expect(screen.getByTestId("quit-intercept-dialog")).not.toBeNull();
    expect(fake.respondToQuitRequest).not.toHaveBeenCalled();
  });
});
