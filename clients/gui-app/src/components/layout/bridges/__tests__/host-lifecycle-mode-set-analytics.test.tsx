// `host_lifecycle_mode_set` end to end across "windows": each window mounts
// the real root bridges (`HostQuitDecisionBridge`, `HostLifecycleAnalyticsBridge`)
// on its own fake runner host and `QueryClient`, and a fake "main" fans each
// lifecycle change out to every window, as desktop main does. The event is
// reported for the WRITE (main's change push, or the set mutation's own
// `applied` reply), attributed by the window that expected it, or - for a
// `cli` writer - by the one window holding the leader Web Lock. All windows
// share one fake `navigator.locks`, as one app:// origin does.
//
// Mocks mirror `host-quit-decision-bridge.test.tsx`, with
// `useLocalHostQuitStatus` pinned to a busy verdict so Stop forces.
const localHostQuitStatusMock = vi.hoisted(
  (): { current: LocalHostQuitStatus } => ({
    current: {
      localHostId: "host-a",
      verdict: {
        kind: "busy",
        busySessionCount: 1,
        breakdown: null,
        statusMinor: 6,
      },
      liveLocalHostIdNow: () => "host-a",
      recheck: vi.fn(),
    },
  }),
);
vi.mock(
  "@/components/host/use-local-host-quit-status",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/host/use-local-host-quit-status")
      >();
    return {
      ...actual,
      useLocalHostQuitStatus: () => localHostQuitStatusMock.current,
    };
  },
);

vi.mock("sonner", () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  },
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostBinding: () => ({ directory: { getLocalEntry: () => null } }),
  };
});

vi.mock("@/hooks/home-focus/use-focus-model", async () => {
  const { EMPTY_FOCUS_MODEL } =
    await import("@/lib/home-focus/build-focus-model");
  return { useFocusModel: () => EMPTY_FOCUS_MODEL };
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type {
  HostLifecycleMode,
  HostLifecycleSetResult,
  HostLifecycleView,
  HostQuitDecisionRequest,
  HostQuitDecisionResponse,
  HostQuitStateEvent,
  IHostLifecycleHost,
  IHostQuitDecisionHost,
} from "@traycer-clients/shared/platform/runner-host";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";
import type { LocalHostQuitStatus } from "@/components/host/use-local-host-quit-status";
import { HostLifecycleAnalyticsBridge } from "@/components/layout/bridges/host-lifecycle-analytics-bridge";
import { HostQuitDecisionBridge } from "@/components/layout/bridges/host-quit-decision-bridge";
import { useRunnerHostLifecycleSetMutation } from "@/hooks/runner/use-runner-host-lifecycle-set-mutation";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { createFakeRunnerHost } from "../../../../../__tests__/create-fake-runner-host";

// ---------------------------------------------------------------------------
// Fake Web Locks (`navigator.locks`)
// ---------------------------------------------------------------------------

interface QueuedLockRequest {
  aborted: boolean;
  readonly invoke: (lock: Lock) => Promise<void>;
}

/**
 * One exclusive, FIFO Web Locks manager shared by every window mounted in a
 * test - the same single app:// origin a real desktop shell's windows share.
 *
 * Only the surface the bridge calls: `holdCliReporterLock` always uses the
 * three-argument `request(name, { signal }, callback)`, so this implements
 * exactly that rather than claiming all of `LockManager`. It reaches the
 * bridge through `Object.defineProperty(navigator, "locks", ...)` below.
 */
class FakeLockManager {
  private readonly queues = new Map<string, QueuedLockRequest[]>();
  private readonly holders = new Map<string, QueuedLockRequest>();
  private grants = 0;

  request<T>(
    name: string,
    options: LockOptions,
    callback: LockGrantedCallback<T>,
  ): Promise<Awaited<T>> {
    return new Promise<Awaited<T>>((resolve, reject) => {
      const entry: QueuedLockRequest = {
        aborted: false,
        invoke: (lock) =>
          Promise.resolve(callback(lock)).then(
            (value) => {
              resolve(value);
            },
            (error: unknown) => {
              reject(error instanceof Error ? error : new Error(String(error)));
            },
          ),
      };

      const queue = this.queues.get(name) ?? [];
      this.queues.set(name, queue);
      queue.push(entry);

      const signal = options.signal;
      if (signal !== undefined) {
        signal.addEventListener("abort", () => {
          if (this.holders.get(name) === entry) return;
          const pending = this.queues.get(name);
          if (pending === undefined) return;
          const index = pending.indexOf(entry);
          if (index === -1) return;
          pending.splice(index, 1);
          entry.aborted = true;
          reject(new DOMException("The request was aborted.", "AbortError"));
        });
      }

      this.grantNext(name);
    });
  }

  /** How many requests have been granted so far, across every lock name. */
  grantCount(): number {
    return this.grants;
  }

  /** How many locks are held right now. */
  heldCount(): number {
    return this.holders.size;
  }

  private grantNext(name: string): void {
    if (this.holders.has(name)) return;
    const queue = this.queues.get(name);
    if (queue === undefined) return;
    const entry = queue.shift();
    if (entry === undefined) return;
    if (entry.aborted) {
      this.grantNext(name);
      return;
    }
    this.holders.set(name, entry);
    this.grants += 1;
    const lock: Lock = { mode: "exclusive", name };
    void entry.invoke(lock).then(() => {
      this.holders.delete(name);
      this.grantNext(name);
    });
  }
}

let lockManager: FakeLockManager;

beforeEach(() => {
  lockManager = new FakeLockManager();
  Object.defineProperty(navigator, "locks", {
    value: lockManager,
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, "locks");
  localHostQuitStatusMock.current = busyStatus();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fake quit host (identical shape to host-quit-decision-bridge.test.tsx's
// `createFakeQuit`)
// ---------------------------------------------------------------------------

interface FakeQuit extends IHostQuitDecisionHost {
  readonly fireRequest: (request: HostQuitDecisionRequest) => void;
  readonly fireState: (event: HostQuitStateEvent) => void;
  readonly respondCalls: HostQuitDecisionResponse[];
  respondImpl: (response: HostQuitDecisionResponse) => Promise<void>;
}

function createFakeQuit(): FakeQuit {
  let requestHandler: ((request: HostQuitDecisionRequest) => void) | null =
    null;
  let stateHandler: ((event: HostQuitStateEvent) => void) | null = null;
  const respondCalls: HostQuitDecisionResponse[] = [];
  const fake: FakeQuit = {
    onQuitRequest: (handler): Disposable => {
      requestHandler = handler;
      return { dispose: () => undefined };
    },
    onQuitState: (handler): Disposable => {
      stateHandler = handler;
      return { dispose: () => undefined };
    },
    respondToQuitRequest: (response) => {
      respondCalls.push(response);
      return fake.respondImpl(response);
    },
    respondImpl: () => Promise.resolve(),
    fireRequest: (request) => requestHandler?.(request),
    fireState: (event) => stateHandler?.(event),
    respondCalls,
  };
  return fake;
}

function busyStatus(): LocalHostQuitStatus {
  return {
    localHostId: "host-a",
    verdict: {
      kind: "busy",
      busySessionCount: 1,
      breakdown: null,
      statusMinor: 6,
    },
    liveLocalHostIdNow: () => "host-a",
    recheck: vi.fn(),
  };
}

function initialAskRequest(): HostQuitDecisionRequest {
  return { requestId: "req-1", mode: "ask", round: "initial" };
}

function busyRetryRequest(): HostQuitDecisionRequest {
  return { requestId: "req-2", mode: "ask", round: "busy-retry" };
}

// ---------------------------------------------------------------------------
// Fake `hostLifecycle` (per window)
// ---------------------------------------------------------------------------

function view(
  overrides: Partial<HostLifecycleView["desired"]>,
): HostLifecycleView {
  return {
    desired: {
      mode: "ask",
      rev: 1,
      updatedBy: null,
      updatedAt: null,
      ...overrides,
    },
    applied: {
      localHostCapability: "managed",
      supervisor: "enforcing",
      admittedAs: null,
    },
    pending: "none",
  };
}

interface FakeHostLifecycle {
  readonly base: Omit<IHostLifecycleHost, "quit">;
  push(next: HostLifecycleView): void;
  hasPendingSet(): boolean;
  resolveSet(result: HostLifecycleSetResult): void;
  current(): HostLifecycleView;
}

function createFakeHostLifecycle(
  initial: HostLifecycleView,
): FakeHostLifecycle {
  let currentView = initial;
  const listeners = new Set<(next: HostLifecycleView) => void>();
  let pendingSetResolve: ((result: HostLifecycleSetResult) => void) | null =
    null;

  const base: Omit<IHostLifecycleHost, "quit"> = {
    get: () => Promise.resolve(currentView),
    set: () =>
      new Promise<HostLifecycleSetResult>((resolve) => {
        pendingSetResolve = resolve;
      }),
    onChange: (handler) => {
      listeners.add(handler);
      return {
        dispose: () => {
          listeners.delete(handler);
        },
      };
    },
  };

  return {
    base,
    push: (next) => {
      currentView = next;
      for (const listener of listeners) listener(next);
    },
    hasPendingSet: () => pendingSetResolve !== null,
    resolveSet: (result) => {
      if (pendingSetResolve === null) {
        throw new Error("FakeHostLifecycle.resolveSet: no pending set() call");
      }
      const resolve = pendingSetResolve;
      pendingSetResolve = null;
      resolve(result);
    },
    current: () => currentView,
  };
}

// ---------------------------------------------------------------------------
// "Main": pushes one view to every mounted window, exactly as desktop main
// fans a lifecycle change out to every window.
// ---------------------------------------------------------------------------

interface Main {
  addWindow(push: (next: HostLifecycleView) => void): void;
  pushToAll(next: HostLifecycleView): void;
}

function createMain(): Main {
  const pushers: Array<(next: HostLifecycleView) => void> = [];
  return {
    addWindow: (push) => {
      pushers.push(push);
    },
    pushToAll: (next) => {
      for (const push of pushers) push(next);
    },
  };
}

// ---------------------------------------------------------------------------
// Root bridges + the set-mutation probe, per window
// ---------------------------------------------------------------------------

/** The root bridges each window mounts, as `root-route-components.tsx` does. */
function WindowBridges(): ReactNode {
  return (
    <>
      <HostQuitDecisionBridge />
      <HostLifecycleAnalyticsBridge />
    </>
  );
}

const SETTABLE_MODES = [
  "background",
  "linked",
  "ask",
  "stop-if-idle",
  "none",
] as const satisfies readonly HostLifecycleMode[];

function SetModeProbe(): ReactNode {
  const mutation = useRunnerHostLifecycleSetMutation();
  return (
    <div>
      {SETTABLE_MODES.map((mode) => (
        <button
          key={mode}
          type="button"
          data-testid={`set-mode-${mode}`}
          onClick={() => {
            mutation.mutate({
              request: { mode, stop: null },
              source: "settings",
            });
          }}
        >
          {`Set ${mode}`}
        </button>
      ))}
    </div>
  );
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

interface MountedWindow {
  readonly container: HTMLElement;
  readonly quit: FakeQuit;
  readonly lifecycle: FakeHostLifecycle;
  unmount(): void;
}

/**
 * Mounts one "window": its own fake runner host and its own `QueryClient`,
 * and resolves once the analytics bridge has read its baseline (a push that
 * lands before that is only a baseline, never a mode set).
 */
async function mountWindow(
  main: Main,
  initial: HostLifecycleView,
): Promise<MountedWindow> {
  const quit = createFakeQuit();
  const lifecycle = createFakeHostLifecycle(initial);
  const hostLifecycle: IHostLifecycleHost = { ...lifecycle.base, quit };
  const runnerHost = createFakeRunnerHost({ hostLifecycle });
  const queryClient = makeQueryClient();
  const container = document.body.appendChild(document.createElement("div"));
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <WindowBridges />
        <SetModeProbe />
      </RunnerHostProvider>
    </QueryClientProvider>,
    { container },
  );
  main.addWindow((next) => {
    lifecycle.push(next);
  });
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });

  return {
    container,
    quit,
    lifecycle,
    unmount: () => {
      rendered.unmount();
      container.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// Analytics spy
// ---------------------------------------------------------------------------

function createAnalyticsSpy() {
  const trackSpy = vi
    .spyOn(Analytics.getInstance(), "track")
    .mockImplementation(() => true);
  const modeSetCalls = () =>
    trackSpy.mock.calls
      .filter((call) => call[0] === AnalyticsEvent.HostLifecycleModeSet)
      .map((call) => call[1]);
  const decisionCallCount = () =>
    trackSpy.mock.calls.filter(
      (call) => call[0] === AnalyticsEvent.HostQuitDecision,
    ).length;
  const waitForDecisionCount = async (count: number): Promise<void> => {
    await waitFor(() => {
      expect(decisionCallCount()).toBe(count);
    });
  };
  return { trackSpy, modeSetCalls, waitForDecisionCount };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("host_lifecycle_mode_set - quit-modal expectation (main never pushes)", () => {
  it("Stop+Remember with no push from main emits zero mode-set events", async () => {
    const main = createMain();
    const { modeSetCalls } = createAnalyticsSpy();
    const windowA = await mountWindow(main, view({}));

    act(() => {
      windowA.quit.fireRequest(initialAskRequest());
    });
    await screen.findByTestId("host-quit-dialog");
    act(() => {
      screen.getByTestId("host-quit-remember").click();
    });
    act(() => {
      screen.getByTestId("host-quit-stop").click();
    });

    await waitFor(() => {
      expect(windowA.quit.respondCalls).toHaveLength(1);
    });

    expect(modeSetCalls()).toEqual([]);
  });
});

describe("host_lifecycle_mode_set - quit-modal expectation (main pushes once)", () => {
  it("Stop+Remember, then main pushes {linked, desktop}: exactly one quit-modal emit", async () => {
    const main = createMain();
    const { modeSetCalls, waitForDecisionCount } = createAnalyticsSpy();
    const windowA = await mountWindow(main, view({}));

    act(() => {
      windowA.quit.fireRequest(initialAskRequest());
    });
    await screen.findByTestId("host-quit-dialog");
    act(() => {
      screen.getByTestId("host-quit-remember").click();
    });
    act(() => {
      screen.getByTestId("host-quit-stop").click();
    });
    // Main writes the remembered mode only once it has the answer.
    await waitFor(() => {
      expect(windowA.quit.respondCalls).toHaveLength(1);
    });

    act(() => {
      main.pushToAll(
        view({
          mode: "linked",
          rev: 2,
          updatedBy: "desktop",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    });

    await waitForDecisionCount(1);

    expect(modeSetCalls()).toEqual([{ mode: "linked", source: "quit-modal" }]);
  });
});

describe("host_lifecycle_mode_set - busy-retry must not double-emit", () => {
  it("Stop+Remember -> push -> busy-retry Stop (remember carried) -> exactly one emit total", async () => {
    const main = createMain();
    const { modeSetCalls, waitForDecisionCount } = createAnalyticsSpy();
    const windowA = await mountWindow(main, view({}));

    act(() => {
      windowA.quit.fireRequest(initialAskRequest());
    });
    await screen.findByTestId("host-quit-dialog");
    act(() => {
      screen.getByTestId("host-quit-remember").click();
    });
    act(() => {
      screen.getByTestId("host-quit-stop").click();
    });

    await waitFor(() => {
      expect(windowA.quit.respondCalls).toHaveLength(1);
    });

    act(() => {
      main.pushToAll(
        view({
          mode: "linked",
          rev: 2,
          updatedBy: "desktop",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    });

    act(() => {
      windowA.quit.fireRequest(busyRetryRequest());
    });
    await screen.findByTestId("host-quit-dialog");
    act(() => {
      screen.getByTestId("host-quit-stop").click();
    });

    await waitForDecisionCount(2);

    expect(modeSetCalls()).toHaveLength(1);
  });

  it("same busy-retry sequence, main's single push arriving only after the second Stop: exactly one emit", async () => {
    const main = createMain();
    const { modeSetCalls, waitForDecisionCount } = createAnalyticsSpy();
    const windowA = await mountWindow(main, view({}));

    act(() => {
      windowA.quit.fireRequest(initialAskRequest());
    });
    await screen.findByTestId("host-quit-dialog");
    act(() => {
      screen.getByTestId("host-quit-remember").click();
    });
    act(() => {
      screen.getByTestId("host-quit-stop").click();
    });

    await waitFor(() => {
      expect(windowA.quit.respondCalls).toHaveLength(1);
    });

    act(() => {
      windowA.quit.fireRequest(busyRetryRequest());
    });
    await screen.findByTestId("host-quit-dialog");
    act(() => {
      screen.getByTestId("host-quit-stop").click();
    });

    await waitForDecisionCount(2);

    act(() => {
      main.pushToAll(
        view({
          mode: "linked",
          rev: 2,
          updatedBy: "desktop",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    });

    expect(modeSetCalls()).toHaveLength(1);
  });
});

describe("host_lifecycle_mode_set - a cancelled quit withdraws the expectation", () => {
  it("Keep+Remember, then cancelled, then a later push {background, desktop}: zero emits", async () => {
    const main = createMain();
    const { modeSetCalls } = createAnalyticsSpy();
    const windowA = await mountWindow(main, view({}));

    act(() => {
      windowA.quit.fireRequest(initialAskRequest());
    });
    await screen.findByTestId("host-quit-dialog");
    act(() => {
      screen.getByTestId("host-quit-remember").click();
    });
    act(() => {
      screen.getByTestId("host-quit-keep").click();
    });

    await waitFor(() => {
      expect(windowA.quit.respondCalls).toHaveLength(1);
    });

    act(() => {
      windowA.quit.fireState({ requestId: "req-1", phase: "cancelled" });
    });

    act(() => {
      main.pushToAll(
        view({
          mode: "background",
          rev: 2,
          updatedBy: "desktop",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    });

    expect(modeSetCalls()).toEqual([]);
  });
});

describe("host_lifecycle_mode_set - cli writer, leader election", () => {
  it("one window: a cli push emits {mode, source:'cli'} exactly once", async () => {
    const main = createMain();
    const { modeSetCalls } = createAnalyticsSpy();
    await mountWindow(main, view({}));

    act(() => {
      main.pushToAll(
        view({
          mode: "background",
          rev: 2,
          updatedBy: "cli",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    });

    expect(modeSetCalls()).toEqual([{ mode: "background", source: "cli" }]);
  });

  it("two windows: one cli push fanned to both emits exactly once", async () => {
    const main = createMain();
    const { modeSetCalls } = createAnalyticsSpy();
    await mountWindow(main, view({}));
    await mountWindow(main, view({}));

    act(() => {
      main.pushToAll(
        view({
          mode: "background",
          rev: 2,
          updatedBy: "cli",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    });

    expect(modeSetCalls()).toEqual([{ mode: "background", source: "cli" }]);
  });

  it("leader failover: after A unmounts and B holds the lock, a cli push emits exactly once", async () => {
    const main = createMain();
    const { modeSetCalls } = createAnalyticsSpy();
    // A mounts first, so A's bridge holds the lock and B's request queues.
    const windowA = await mountWindow(main, view({}));
    expect(lockManager.grantCount()).toBe(1);
    await mountWindow(main, view({}));
    expect(lockManager.grantCount()).toBe(1);

    windowA.unmount();

    // A released it and B was granted: B is the only window left to report.
    await waitFor(() => {
      expect(lockManager.grantCount()).toBe(2);
    });
    expect(lockManager.heldCount()).toBe(1);

    act(() => {
      main.pushToAll(
        view({
          mode: "background",
          rev: 2,
          updatedBy: "cli",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    });

    expect(modeSetCalls()).toEqual([{ mode: "background", source: "cli" }]);
  });
});

describe("host_lifecycle_mode_set - the settings surface's own commit", () => {
  it("two windows; A's probe sets background; main pushes to both AFTER the reply resolves: exactly one {background, settings}", async () => {
    const main = createMain();
    const { modeSetCalls } = createAnalyticsSpy();
    const windowA = await mountWindow(main, view({}));
    await mountWindow(main, view({}));
    const withinA = within(windowA.container);

    act(() => {
      withinA.getByTestId("set-mode-background").click();
    });

    const appliedView = view({
      mode: "background",
      rev: 2,
      updatedBy: "desktop",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await waitFor(() => {
      expect(windowA.lifecycle.hasPendingSet()).toBe(true);
    });
    await act(async () => {
      windowA.lifecycle.resolveSet({ kind: "applied", view: appliedView });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(modeSetCalls()).toHaveLength(1);
    });
    expect(modeSetCalls()).toEqual([
      { mode: "background", source: "settings" },
    ]);

    act(() => {
      main.pushToAll(appliedView);
    });

    expect(modeSetCalls()).toHaveLength(1);
  });

  it("same as above with main's push arriving BEFORE the reply resolves: exactly one {background, settings}", async () => {
    const main = createMain();
    const { modeSetCalls } = createAnalyticsSpy();
    const windowA = await mountWindow(main, view({}));
    await mountWindow(main, view({}));
    const withinA = within(windowA.container);

    act(() => {
      withinA.getByTestId("set-mode-background").click();
    });

    const appliedView = view({
      mode: "background",
      rev: 2,
      updatedBy: "desktop",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    // Main has the set (it is pending) and has written: its push reaches both
    // windows before the reply reaches A.
    await waitFor(() => {
      expect(windowA.lifecycle.hasPendingSet()).toBe(true);
    });
    act(() => {
      main.pushToAll(appliedView);
    });
    await waitFor(() => {
      expect(modeSetCalls()).toHaveLength(1);
    });
    await act(async () => {
      windowA.lifecycle.resolveSet({ kind: "applied", view: appliedView });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(modeSetCalls()).toHaveLength(1);
    });
    expect(modeSetCalls()).toEqual([
      { mode: "background", source: "settings" },
    ]);
  });
});

describe("host_lifecycle_mode_set - a desktop write no window asked for", () => {
  it("two windows; a desktop push neither expected (the tray's own set) emits nothing in either", async () => {
    const main = createMain();
    const { modeSetCalls } = createAnalyticsSpy();
    await mountWindow(main, view({}));
    await mountWindow(main, view({}));

    act(() => {
      main.pushToAll(
        view({
          mode: "linked",
          rev: 2,
          updatedBy: "desktop",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    });

    expect(modeSetCalls()).toEqual([]);
  });
});

describe("host_lifecycle_mode_set - no-op pushes and non-applied replies emit nothing", () => {
  it("a push identical to the view get() returned, and a superseded set reply, both emit nothing", async () => {
    const main = createMain();
    const { modeSetCalls } = createAnalyticsSpy();
    const initial = view({});
    const windowA = await mountWindow(main, initial);
    const withinA = within(windowA.container);

    act(() => {
      main.pushToAll(initial);
    });
    expect(modeSetCalls()).toEqual([]);

    act(() => {
      withinA.getByTestId("set-mode-background").click();
    });
    await waitFor(() => {
      expect(windowA.lifecycle.hasPendingSet()).toBe(true);
    });
    await act(async () => {
      windowA.lifecycle.resolveSet({
        kind: "superseded",
        view: view({
          mode: "linked",
          rev: 2,
          updatedBy: "cli",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      });
      await Promise.resolve();
    });

    expect(modeSetCalls()).toEqual([]);
  });

  it("a stop-refused set reply emits nothing", async () => {
    const main = createMain();
    const { modeSetCalls } = createAnalyticsSpy();
    const windowA = await mountWindow(main, view({}));
    const withinA = within(windowA.container);

    act(() => {
      withinA.getByTestId("set-mode-none").click();
    });
    await waitFor(() => {
      expect(windowA.lifecycle.hasPendingSet()).toBe(true);
    });
    await act(async () => {
      windowA.lifecycle.resolveSet({
        kind: "stop-refused",
        reason: "host-busy",
        message: "The host is still working.",
        view: view({}),
      });
      await Promise.resolve();
    });

    expect(modeSetCalls()).toEqual([]);
  });

  it("a push with only updatedAt changed (same rev and mode) emits nothing", async () => {
    const main = createMain();
    const { modeSetCalls } = createAnalyticsSpy();
    const initial = view({ updatedAt: null });
    await mountWindow(main, initial);

    act(() => {
      main.pushToAll(view({ updatedAt: "2026-01-01T00:00:00.000Z" }));
    });

    expect(modeSetCalls()).toEqual([]);
  });
});
