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
import {
  QuitInterceptBridge,
  __parseQuitSnapshotForTests,
} from "@/components/layout/bridges/quit-intercept-bridge";
import {
  setActiveDesktopPerWindowProjectionBridge,
  type DesktopPerWindowProjectionBridge,
} from "@/lib/windows/per-window-projection-debounce";
import { appLogger } from "@/lib/logger";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import type { OpenEpicSessionRegistry } from "@/stores/epics/open-epic/session-registry";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import { fileEditRuntimeRegistry } from "@/lib/workspace/file-edit-runtime-registry";

const electronTabsMocks = vi.hoisted(() => ({
  drainElectronTabHandoffs: vi.fn<() => Promise<void>>(),
}));

vi.mock("@/lib/browser-view/sessions/electron-tabs", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/browser-view/sessions/electron-tabs")
    >();
  return {
    ...actual,
    drainElectronTabHandoffs: electronTabsMocks.drainElectronTabHandoffs,
  };
});

interface RunnerHostOnWindow {
  runnerHost?: unknown;
}
type HandleStore = OpenEpicStoreHandle["store"];
type QuitDecision = "proceed" | "userConfirmedDiscard" | "userCancelled";
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
    detachTransport: () => undefined,
    requestFreshSnapshot: () => undefined,
    isClean: () => !state.isDirty,
    hotArtifactRoomIdsForTests: () => [],
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
    vi.restoreAllMocks();
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
      {
        epicId: "eA",
        title: "Alpha",
        queueSize: 0,
        isDirty: true,
        unsyncable: false,
      },
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
      {
        epicId: "eA",
        title: "Alpha",
        queueSize: 0,
        isDirty: true,
        unsyncable: false,
      },
      {
        epicId: "eB",
        title: "Beta",
        queueSize: 1,
        isDirty: true,
        unsyncable: false,
      },
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

    // Neither half may promise that syncing is under way or that waiting is
    // the user's only option: a buffer retained across a host re-point has no
    // transport, so it never syncs, and `userCancelled` is a real exit.
    expect(screen.getByText("You have unsynced changes.")).not.toBeNull();
    expect(
      screen.getByText(
        "2 Epic(s) have not finished syncing. Quitting continues on its own if they do, but some never will. Cancel to stay in the app, or quit and discard them.",
      ),
    ).not.toBeNull();

    const list = screen.getByTestId("quit-intercept-epic-list");
    expect(list.textContent).toContain("Alpha");
    expect(list.textContent).toContain("Beta");
  });

  // F: `unsyncable` was declared on `AppLifecycleUnsyncedEditsEntry` but the
  // parser never read it off the wire payload, so it was permanently
  // `undefined` regardless of what main sent. Pins both directions: an
  // explicit `false` must round-trip as `false` (not get coerced to the
  // absent-value default), and an explicit `true` and a genuinely absent
  // field must both come out `true` - the safe reading when durability is
  // unknown, since main's own parser (ipc-parsers.ts) refuses a row missing
  // it outright rather than guessing.
  it("round-trips unsyncable: true, false, and defaults an absent field to true", () => {
    const parsed = __parseQuitSnapshotForTests([
      { epicId: "eA", title: "Alpha", queueSize: 2, unsyncable: true },
      { epicId: "eB", title: "Beta", queueSize: 1, unsyncable: false },
      { epicId: "eC", title: "Gamma", queueSize: 3 },
    ]);
    expect(parsed.map((entry) => [entry.epicId, entry.unsyncable])).toEqual([
      ["eA", true],
      ["eB", false],
      ["eC", true],
    ]);
  });

  it("ranks the acting safe exit above the inert one: Cancel is last and carries the only primary fill", () => {
    const fake = installAppLifecycleFake();
    const registry = __getOpenEpicRegistryForTests();
    const handleA = buildHandle("eA", "Alpha");
    registry.acquire("eA", () => handleA);
    handleA.setDirty(true, 2);

    render(<QuitInterceptBridge />);

    act(() => {
      fake.emitQuitRequest([{ epicId: "eA", title: "Alpha", queueSize: 2 }]);
    });

    const footer = screen.getByTestId("quit-intercept-discard").parentElement;
    // Positive premise, thrown rather than asserted: without a real footer
    // every ranking below would run over an empty list and pass by vacancy.
    if (footer === null) throw new Error("the quit dialog footer is missing");
    const buttons = Array.from(footer.querySelectorAll("button"));
    expect(buttons.length).toBe(3);

    // `DialogFooter` is `flex flex-col-reverse … sm:flex-row sm:justify-end`,
    // so at `sm:` and above DOM order paints left to right: the last child is
    // the rightmost control. This dialog family reserves that slot for the safe
    // action (`unsynced-close-dialog`, `unsynced-epic-move-dialog`), and it
    // used to hold "Wait" - which has no `onClick` and, against a retained
    // buffer, can never resolve.
    expect(buttons.map((button) => button.getAttribute("data-testid"))).toEqual(
      [
        "quit-intercept-discard",
        "quit-intercept-wait",
        "quit-intercept-cancel",
      ],
    );

    // Stated as "which controls carry the primary fill", not as "Wait does
    // not", so the assertion reports the real ranking on failure and cannot be
    // satisfied by a footer where nothing is emphasised at all. On the unfixed
    // tree this reads `["quit-intercept-wait"]`.
    const primaryFilled = buttons
      .filter((button) => button.className.split(" ").includes("bg-primary"))
      .map((button) => button.getAttribute("data-testid"));
    expect(primaryFilled).toEqual(["quit-intercept-cancel"]);
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
      {
        epicId: "eA",
        title: "Alpha",
        queueSize: 4,
        isDirty: true,
        unsyncable: false,
      },
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

  it("defers the fresh-snapshot reply until file recovery persistence completes", async () => {
    const fake = installAppLifecycleFake();
    let resolveRecovery: (() => void) | null = null;
    vi.spyOn(fileEditRuntimeRegistry, "flushRecovery").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRecovery = resolve;
        }),
    );

    render(<QuitInterceptBridge />);
    act(() => {
      fake.emitFreshQuery({ requestId: "req-file-recovery" });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(fake.respondFreshUnsyncedSnapshot).not.toHaveBeenCalled();

    await act(async () => {
      resolveRecovery?.();
      await Promise.resolve();
    });
    expect(fake.respondFreshUnsyncedSnapshot).toHaveBeenCalledWith({
      requestId: "req-file-recovery",
      snapshot: [],
    });
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
      {
        epicId: "eA",
        title: "Alpha",
        queueSize: 2,
        isDirty: true,
        unsyncable: false,
      },
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

  // T-userCancelled: prior to the third quit-decision verb, Escape / the close
  // button / an outside click were all swallowed by `onOpenChange` refusing
  // every close - the only working control was "Quit and discard". These
  // fixtures pin the reopened doors: each one now RESPONDS "userCancelled",
  // not just dismisses. A path that dismisses without responding leaves main
  // waiting forever - that is the original hang reintroduced, so these stay
  // as separate `it`s rather than one collapsed assertion.

  /**
   * Builds a dirty buffer retained across a host re-point (F10): acquire a
   * dirty live handle, mark it dirty, then `replaceMounted` it with a clean
   * one. The registry retains the outgoing dirty handle because
   * `detachTransport()` has already been called on it - it can never sync,
   * so its row never clears on its own. Verifies the retention actually
   * happened before returning: a fixture built on a retention that silently
   * did not occur would prove nothing about what depends on it.
   */
  function buildRetainedDirtyBuffer(
    registry: OpenEpicSessionRegistry,
    epicId: string,
    title: string,
    queueSize: number,
  ): void {
    const dirty = buildHandle(epicId, title);
    registry.acquireMounted(epicId, () => dirty);
    dirty.setDirty(true, queueSize);
    const clean = buildHandle(epicId, title);
    const replaced = registry.replaceMounted(epicId, dirty, clean, {
      hostStamp: "host-a",
      ownerIdentityKey: "key-a",
      editsTransferredToReplacement: false,
    });
    if (!replaced) {
      throw new Error("replaceMounted did not accept the outgoing handle");
    }
    // Positive checks on the premise, not just its consequence: the row
    // exists in the aggregated read path AND the retention count says one
    // buffer is actually held.
    expect(registry.retainedCountForTests(epicId)).toBe(1);
    const rows = registry.getUnsyncedEdits();
    expect(rows.some((row) => row.epicId === epicId)).toBe(true);
  }

  it("Cancel responds userCancelled, unmounts the dialog, and releases the pointer-events lock even with a retained buffer that can never sync", () => {
    const fake = installAppLifecycleFake();
    const registry = __getOpenEpicRegistryForTests();
    buildRetainedDirtyBuffer(registry, "eRetained", "Retained Epic", 3);

    render(<QuitInterceptBridge />);

    act(() => {
      fake.emitQuitRequest({
        requestId: "quit-cancel-1",
        snapshot: [
          { epicId: "eRetained", title: "Retained Epic", queueSize: 3 },
        ],
      });
    });

    expect(screen.getByTestId("quit-intercept-dialog")).not.toBeNull();
    // Radix locks the page while a modal dialog is open - confirm the locked
    // value first so the post-cancel assertion is checking the opposite of
    // what is actually true while the dialog is up, not a guess.
    expect(document.body.style.pointerEvents).toBe("none");

    act(() => {
      fireEvent.click(screen.getByTestId("quit-intercept-cancel"));
    });

    // (a) a decision was actually sent, and it is the right one.
    expect(fake.respondToQuitRequest).toHaveBeenCalledTimes(1);
    expect(fake.respondToQuitRequest).toHaveBeenCalledWith({
      requestId: "quit-cancel-1",
      decision: "userCancelled",
    });
    // (b) the modal is gone.
    expect(screen.queryByTestId("quit-intercept-dialog")).toBeNull();
    // (c) the surface is interactive again - a decision going out and the
    // dialog staying mounted (or the lock staying on) both pass on a broken
    // version that leaves the app covered.
    expect(document.body.style.pointerEvents).not.toBe("none");
  });

  it("does not auto-resolve while a retained, un-syncable buffer keeps the unsynced-edits row non-empty", () => {
    const fake = installAppLifecycleFake();
    const registry = __getOpenEpicRegistryForTests();
    buildRetainedDirtyBuffer(registry, "eStuck", "Stuck Epic", 5);

    render(<QuitInterceptBridge />);

    act(() => {
      fake.emitQuitRequest({
        requestId: "quit-stuck-1",
        snapshot: [{ epicId: "eStuck", title: "Stuck Epic", queueSize: 5 }],
      });
    });

    // Generous advance - a retained buffer with a detached transport has no
    // way to ever clear on its own, so nothing here should ever fire.
    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });

    expect(fake.respondToQuitRequest).not.toHaveBeenCalled();
    expect(screen.getByTestId("quit-intercept-dialog")).not.toBeNull();
  });

  it("the close (X) button responds userCancelled and unmounts the dialog", () => {
    const fake = installAppLifecycleFake();
    const registry = __getOpenEpicRegistryForTests();
    const handleA = buildHandle("eX", "Alpha");
    registry.acquire("eX", () => handleA);
    handleA.setDirty(true, 2);

    render(<QuitInterceptBridge />);

    act(() => {
      fake.emitQuitRequest({
        requestId: "quit-x-1",
        snapshot: [{ epicId: "eX", title: "Alpha", queueSize: 2 }],
      });
    });

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    });

    expect(fake.respondToQuitRequest).toHaveBeenCalledTimes(1);
    expect(fake.respondToQuitRequest).toHaveBeenCalledWith({
      requestId: "quit-x-1",
      decision: "userCancelled",
    });
    expect(screen.queryByTestId("quit-intercept-dialog")).toBeNull();
  });

  it("Escape responds userCancelled and unmounts the dialog", () => {
    const fake = installAppLifecycleFake();
    const registry = __getOpenEpicRegistryForTests();
    const handleA = buildHandle("eEsc", "Alpha");
    registry.acquire("eEsc", () => handleA);
    handleA.setDirty(true, 2);

    render(<QuitInterceptBridge />);

    act(() => {
      fake.emitQuitRequest({
        requestId: "quit-esc-1",
        snapshot: [{ epicId: "eEsc", title: "Alpha", queueSize: 2 }],
      });
    });

    act(() => {
      fireEvent.keyDown(screen.getByTestId("quit-intercept-dialog"), {
        key: "Escape",
        code: "Escape",
      });
    });

    expect(fake.respondToQuitRequest).toHaveBeenCalledTimes(1);
    expect(fake.respondToQuitRequest).toHaveBeenCalledWith({
      requestId: "quit-esc-1",
      decision: "userCancelled",
    });
    expect(screen.queryByTestId("quit-intercept-dialog")).toBeNull();
  });

  // NOT COVERED HERE - COVERED IN A REAL BROWSER: the third dismissal path, an
  // outside/overlay pointer-down, is asserted end to end by
  // `scripts/quit-intercept-cancel-browser.mjs` (headless Chrome over CDP,
  // wired into `scripts/run-tests.ts` behind the same env flag CI already sets
  // for the diff-edit browser regression). There it responds `userCancelled`,
  // unmounts, and the window is measurably interactive again afterwards. Read
  // the rest of this note as "why not in jsdom", not as "untested".
  //
  // It could not be driven in this jsdom/vitest
  // setup, in or out of this file. Confirmed by direct repro against a bare
  // `radix-ui` `Dialog.Root`/`Content` (no app code at all): firing
  // `fireEvent.pointerDown(document.body)` after flushing the real macrotask
  // Radix's `DismissableLayer` defers its listener registration by
  // (`await act(async () => { await new Promise(r => setTimeout(r, 0)); })`)
  // does dispatch `dismissableLayer.pointerDownOutside` in an *isolated*
  // scratch file, but the identical sequence against this repo's actual
  // `<Dialog><DialogContent>` wrapper (still with zero other app code
  // mounted) never fires it - `onOpenChange` is not called. `vi.useFakeTimers()`
  // is not the variable: the failure reproduces with real timers throughout.
  // This repo's own `promotable-modal-frame.test.tsx` documents the same
  // class of gap ("a bare unguarded dialog does NOT dismiss on
  // `fireEvent.pointerDown` in jsdom either") for a different modal, so this
  // is a pre-existing environment limitation, not something introduced by
  // this change. Escape and the close button both route through the exact
  // same `onOpenChange(false)` callback this component wires up (see the
  // `handleCancel` call site in `quit-intercept-bridge.tsx`'s `onOpenChange`),
  // so the two fixtures above exercise all of the app-level wiring an outside
  // click would also exercise; the part this environment cannot drive is
  // Radix's own decision to call `onOpenChange` on that gesture - which is
  // exactly what the browser regression named above does drive.

  it("re-arms quitDecisionResolvedRef/quitRequestIdRef after Cancel, so a later quit request gets a fresh decision", () => {
    const fake = installAppLifecycleFake();
    const registry = __getOpenEpicRegistryForTests();
    const handleA = buildHandle("eRearm", "Alpha");
    registry.acquire("eRearm", () => handleA);
    handleA.setDirty(true, 2);

    render(<QuitInterceptBridge />);

    act(() => {
      fake.emitQuitRequest({
        requestId: "quit-first",
        snapshot: [{ epicId: "eRearm", title: "Alpha", queueSize: 2 }],
      });
    });
    act(() => {
      fireEvent.click(screen.getByTestId("quit-intercept-cancel"));
    });
    expect(fake.respondToQuitRequest).toHaveBeenCalledTimes(1);
    expect(fake.respondToQuitRequest).toHaveBeenNthCalledWith(1, {
      requestId: "quit-first",
      decision: "userCancelled",
    });
    expect(screen.queryByTestId("quit-intercept-dialog")).toBeNull();

    // A brand-new quit request, with a new requestId, arrives later (e.g. a
    // second Cmd+Q).
    act(() => {
      fake.emitQuitRequest({
        requestId: "quit-second",
        snapshot: [{ epicId: "eRearm", title: "Alpha", queueSize: 2 }],
      });
    });
    expect(screen.getByTestId("quit-intercept-dialog")).not.toBeNull();

    act(() => {
      fireEvent.click(screen.getByTestId("quit-intercept-discard"));
    });

    expect(fake.respondToQuitRequest).toHaveBeenCalledTimes(2);
    expect(fake.respondToQuitRequest).toHaveBeenNthCalledWith(2, {
      requestId: "quit-second",
      decision: "userConfirmedDiscard",
    });
    expect(screen.queryByTestId("quit-intercept-dialog")).toBeNull();
  });
  it("reports the browser handoff drain even when the drain REJECTS", async () => {
    // `browser.sessions` disconnecting mid-handoff rejects the drain. Swallowed
    // without a reply, main's waiter sat out its whole
    // BROWSER_HANDOFF_DRAIN_TIMEOUT_MS - a 10s stall on quit and on every
    // window close that hits this path.
    const respondBrowserHandoffsDrained = vi.fn(() => Promise.resolve());
    let emitDrain: ((request: { readonly requestId: string }) => void) | null =
      null;
    const windowHost = window as WindowMutable;
    windowHost.runnerHost = {
      appLifecycle: {
        setUnsyncedEditsSnapshot: vi.fn(() => Promise.resolve()),
        respondToQuitRequest: vi.fn(() => Promise.resolve()),
        onQuitRequested: vi.fn(() => ({ dispose: () => undefined })),
        onDrainBrowserHandoffs: vi.fn(
          (handler: (request: { readonly requestId: string }) => void) => {
            emitDrain = handler;
            return {
              dispose: () => {
                emitDrain = null;
              },
            };
          },
        ),
        respondBrowserHandoffsDrained,
      },
    };
    electronTabsMocks.drainElectronTabHandoffs.mockImplementation(() =>
      Promise.reject(new Error("browser sessions disconnected")),
    );

    render(<QuitInterceptBridge />);

    const emit = emitDrain as
      | ((request: { readonly requestId: string }) => void)
      | null;
    if (emit === null) throw new Error("no drain subscriber");
    act(() => {
      emit({ requestId: "drain-1" });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(respondBrowserHandoffsDrained).toHaveBeenCalledTimes(1);
    expect(respondBrowserHandoffsDrained).toHaveBeenCalledWith({
      requestId: "drain-1",
    });
  });
});
