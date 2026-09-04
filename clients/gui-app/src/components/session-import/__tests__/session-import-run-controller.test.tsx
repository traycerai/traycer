import { StrictMode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { SessionImportSelection } from "@traycer/protocol/host/session-import/candidate";
import type { PermissionMode } from "@traycer/protocol/persistence/epic/schemas";
import { useSettingsStore } from "@/stores/settings/settings-store";
import type {
  SessionImportRunCallbacks,
  SessionImportRunClientOptions,
} from "@traycer-clients/shared/host-transport/session-import-run-client";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";

/**
 * Captures every `SessionImportRunClient` the controller constructs, in
 * construction order - the probe it opens on mount, and (were the guard ever
 * to fail) a second client from a `start()` call. Mocking at this seam, the
 * same one `session-import-wizard.test.tsx` and `migration-run-controller.test.tsx`
 * use for their own stream clients, lets a test play server frames straight
 * into the controller via the captured callbacks.
 */
interface RunClientInstance {
  readonly selections: ReadonlyArray<SessionImportSelection>;
  readonly permissionMode: PermissionMode;
  readonly callbacks: SessionImportRunCallbacks;
  readonly close: Mock<() => void>;
}

const runClientHarness = vi.hoisted(() => ({
  instances: [] as RunClientInstance[],
}));

vi.mock(
  "@traycer-clients/shared/host-transport/session-import-run-client",
  () => ({
    SessionImportRunClient: class {
      private readonly closeMock = vi.fn();

      constructor(options: SessionImportRunClientOptions) {
        runClientHarness.instances.push({
          selections: options.selections,
          permissionMode: options.permissionMode,
          callbacks: options.callbacks,
          close: this.closeMock,
        });
      }

      close(): void {
        this.closeMock();
      }
    },
  }),
);

/** Stands in for the app-wide stream binding, as the wizard suite does. */
interface StreamBindingHarness {
  client: object | null;
  hostId: string | null;
}

const streamBinding = vi.hoisted((): StreamBindingHarness => ({
  client: { stream: "test" },
  hostId: "host-a",
}));
vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => streamBinding.client,
  useStreamHostId: () => streamBinding.hostId,
}));

const invalidateQueriesMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: invalidateQueriesMock }),
}));

import { SessionImportRunController } from "@/components/session-import/session-import-run-controller";
import {
  getSessionImportStartHandle,
  type SessionImportRunRequest,
  type SessionImportRunTarget,
} from "@/components/session-import/session-import-run-handle";
import {
  sessionImportRunFor,
  useSessionImportRunStore,
  type SessionImportRunState,
} from "@/stores/session-import/session-import-run-store";

const SELECTION: SessionImportSelection = {
  harness: "claude",
  nativeSessionId: "s1",
};

function requireInstance(index: number): RunClientInstance {
  const instance = runClientHarness.instances.at(index);
  if (instance === undefined) {
    throw new Error(`Expected a run client at index ${index}`);
  }
  return instance;
}

/**
 * A stub satisfying `IHostStreamClient` honestly rather than casting - never
 * exercised by this suite, since `SessionImportRunClient` is itself mocked
 * above and never calls through to it.
 */
function fakeWsStreamClient(): IHostStreamClient<HostStreamRpcRegistry> {
  return {
    subscribe: () => {
      throw new Error("not exercised by this test");
    },
    subscribeWithParamsProvider: () => {
      throw new Error("not exercised by this test");
    },
    close: () => undefined,
    isClosed: () => false,
    isReady: () => true,
    notifyBearerRotated: () => undefined,
    reconnectAll: () => undefined,
    getMethodSupport: () => "unknown",
    subscribeMethodSupport: () => () => undefined,
    getMethodSchemaVersion: () => null,
    subscribeAvailabilityRecovered: () => () => undefined,
    getClosedReason: () => null,
    onClosed: () => () => undefined,
    instanceId: "fake-ws-stream-client",
  };
}

/** The target every `start()` call in this suite hands the current binding under. */
function startTarget(): SessionImportRunTarget {
  const hostId = streamBinding.hostId;
  if (hostId === null) {
    throw new Error("Expected a bound host id in this test.");
  }
  return {
    binding: { wsStreamClient: fakeWsStreamClient(), hostId, retain: null },
    hostId,
  };
}

function runFor(hostId: string): SessionImportRunState {
  return sessionImportRunFor(useSessionImportRunStore.getState(), hostId);
}

/** The store slice for the host the suite is currently bound to. */
function currentRun(): SessionImportRunState {
  return sessionImportRunFor(
    useSessionImportRunStore.getState(),
    streamBinding.hostId,
  );
}

beforeEach(() => {
  streamBinding.client = { stream: "test" };
  streamBinding.hostId = "host-a";
  runClientHarness.instances = [];
  invalidateQueriesMock.mockClear();
  useSessionImportRunStore.setState({ runs: new Map() });
});

afterEach(() => {
  cleanup();
  useSessionImportRunStore.setState({ runs: new Map() });
});

describe("<SessionImportRunController />", () => {
  it("opens a selections:[] probe on mount while the store is idle", () => {
    render(<SessionImportRunController />);

    expect(runClientHarness.instances).toHaveLength(1);
    expect(requireInstance(0).selections).toEqual([]);
  });

  it("closes the probe and leaves the store idle when the host answers with nothing running", () => {
    render(<SessionImportRunController />);
    const probe = requireInstance(0);

    act(() => {
      probe.callbacks.onStarted({ attached: false, runId: "run-1", total: 0 });
    });

    expect(probe.close).toHaveBeenCalledTimes(1);
    expect(currentRun().status).toBe("idle");
  });

  it("attaches to a run already in flight and folds its progress and completion into the store", () => {
    render(<SessionImportRunController />);
    const probe = requireInstance(0);

    act(() => {
      probe.callbacks.onStarted({
        attached: true,
        runId: "run-1",
        total: 4,
      });
    });

    expect(probe.close).not.toHaveBeenCalled();
    const afterStarted = currentRun();
    expect(afterStarted.status).toBe("running");
    expect(afterStarted.attached).toBe(true);
    expect(afterStarted.runId).toBe("run-1");
    expect(afterStarted.total).toBe(4);

    act(() => {
      probe.callbacks.onProgress({
        runId: "run-1",
        index: 0,
        total: 4,
        harness: "claude",
        nativeSessionId: "s1",
        outcome: { kind: "imported", epicId: "epic-1", chatId: "chat-1" },
      });
    });

    expect(currentRun().outcomes.size).toBe(1);

    act(() => {
      probe.callbacks.onComplete({
        runId: "run-1",
        counts: { imported: 1, skippedAlreadyImported: 0, failed: 0 },
      });
    });

    const afterComplete = currentRun();
    expect(afterComplete.status).toBe("complete");
    expect(afterComplete.finalCounts).toEqual({
      imported: 1,
      skippedAlreadyImported: 0,
      failed: 0,
    });
    // `onComplete` closes the subscription the same way a run this window
    // started does - there is nothing left for it to report.
    expect(probe.close).toHaveBeenCalledTimes(1);
  });

  it("does not open a second client when start() is called after the probe attached", () => {
    render(<SessionImportRunController />);
    const probe = requireInstance(0);

    act(() => {
      probe.callbacks.onStarted({
        attached: true,
        runId: "run-1",
        total: 4,
      });
    });

    const handle = getSessionImportStartHandle();
    if (handle === null) {
      throw new Error("Expected a session import start handle.");
    }
    const request: SessionImportRunRequest = {
      selections: [SELECTION],
      titles: new Map([["claude:s1", "My session"]]),
    };
    act(() => {
      handle.start(request, startTarget());
    });

    // One run at a time is the contract - a second subscribe here would
    // attach to the first and silently drop this submission's selections.
    expect(runClientHarness.instances).toHaveLength(1);
  });

  it("closes a probe still waiting for its answer and subscribes with the selections when start() is called", () => {
    render(<SessionImportRunController />);
    const probe = requireInstance(0);

    const handle = getSessionImportStartHandle();
    if (handle === null) {
      throw new Error("Expected a session import start handle.");
    }
    const request: SessionImportRunRequest = {
      selections: [SELECTION],
      titles: new Map([["claude:s1", "My session"]]),
    };
    act(() => {
      handle.start(request, startTarget());
    });

    // The probe was only asking; the click must not be dropped for it. If a
    // run WAS in flight, this subscribe attaches to it just as the probe
    // would have.
    expect(probe.close).toHaveBeenCalledTimes(1);
    expect(runClientHarness.instances).toHaveLength(2);
    expect(requireInstance(1).selections).toEqual([SELECTION]);
    expect(currentRun().status).toBe("starting");
  });

  it("subscribes with this install's default permission mode, read when the run starts", () => {
    render(<SessionImportRunController />);
    const handle = getSessionImportStartHandle();
    if (handle === null) {
      throw new Error("Expected a session import start handle.");
    }
    // Changed AFTER mount: the mode is read at subscribe time, so an imported
    // chat starts under whatever a new chat would get right now.
    act(() => {
      useSettingsStore.setState({ defaultPermission: "auto_accept_edits" });
    });
    const request: SessionImportRunRequest = {
      selections: [SELECTION],
      titles: new Map([["claude:s1", "My session"]]),
    };
    act(() => {
      handle.start(request, startTarget());
    });

    expect(requireInstance(1).permissionMode).toBe("auto_accept_edits");
  });

  it("probes a new host straight away and keeps the previous host's run", () => {
    const view = render(<SessionImportRunController />);
    const hostAProbe = requireInstance(0);
    act(() => {
      hostAProbe.callbacks.onStarted({
        attached: true,
        runId: "run-1",
        total: 2,
      });
    });

    // The app is pointed at another host while host-a's run is still going.
    // Runs are per host, so host-a's does not hold the question back: host-b
    // has never been asked, and a run in flight there is a fact this window
    // has no other way to learn.
    streamBinding.client = { stream: "test-b" };
    streamBinding.hostId = "host-b";
    view.rerender(<SessionImportRunController />);

    expect(runClientHarness.instances).toHaveLength(2);
    const hostBProbe = requireInstance(1);
    expect(hostBProbe.selections).toEqual([]);
    act(() => {
      hostBProbe.callbacks.onStarted({
        attached: true,
        runId: "run-2",
        total: 3,
      });
    });
    act(() => {
      hostAProbe.callbacks.onComplete({
        runId: "run-1",
        counts: { imported: 2, skippedAlreadyImported: 0, failed: 0 },
      });
    });

    // Each machine's frames land in its own slice: host-a's summary does not
    // replace the run host-b is still reporting.
    const hostA = runFor("host-a");
    expect(hostA.status).toBe("complete");
    expect(hostA.runId).toBe("run-1");
    const hostB = runFor("host-b");
    expect(hostB.status).toBe("running");
    expect(hostB.runId).toBe("run-2");
    expect(hostB.total).toBe(3);
  });

  it("does not ask the same binding again after its own run finishes", () => {
    render(<SessionImportRunController />);
    const probe = requireInstance(0);
    act(() => {
      probe.callbacks.onStarted({ attached: false, runId: "run-0", total: 0 });
    });
    const handle = getSessionImportStartHandle();
    if (handle === null) {
      throw new Error("Expected a session import start handle.");
    }
    act(() => {
      handle.start(
        {
          selections: [SELECTION],
          titles: new Map([["claude:s1", "My session"]]),
        },
        startTarget(),
      );
    });
    const run = requireInstance(1);
    act(() => {
      run.callbacks.onStarted({ attached: false, runId: "run-1", total: 1 });
      run.callbacks.onComplete({
        runId: "run-1",
        counts: { imported: 1, skippedAlreadyImported: 0, failed: 0 },
      });
    });

    // The binding was probed at mount; a client closing on it is not a new
    // question, and a fresh probe here would re-ask on every finished run.
    expect(runClientHarness.instances).toHaveLength(2);
  });

  it("asks again after StrictMode replays the effect, instead of treating the closed probe as answered", () => {
    render(
      <StrictMode>
        <SessionImportRunController />
      </StrictMode>,
    );

    // setup -> cleanup -> setup: the first probe is closed unanswered, the
    // second is the live one. Without a live probe a dev build would never
    // notice a run already going on the host.
    expect(runClientHarness.instances).toHaveLength(2);
    expect(requireInstance(0).close).toHaveBeenCalledTimes(1);
    expect(requireInstance(1).close).not.toHaveBeenCalled();
    expect(requireInstance(1).selections).toEqual([]);
  });

  it("closes the probe on unmount when no answer has arrived yet", () => {
    const { unmount } = render(<SessionImportRunController />);
    const probe = requireInstance(0);

    unmount();

    expect(probe.close).toHaveBeenCalledTimes(1);
  });
});
