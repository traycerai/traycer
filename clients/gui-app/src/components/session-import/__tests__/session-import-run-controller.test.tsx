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
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import type {
  SessionImportRunCallbacks,
  SessionImportRunClientOptions,
} from "@traycer-clients/shared/host-transport/session-import-run-client";
import type { IStreamClient } from "@traycer-clients/shared/host-transport/i-stream-client";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { StreamRuntimeBinding } from "@/lib/host/stream-runtime-context";

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
  readonly wsStreamClient: IStreamClient<HostStreamRpcRegistry>;
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
          wsStreamClient: options.wsStreamClient,
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

/**
 * Stands in for the app-wide stream binding, including the lease the real
 * provider gives a long-lived run. A binding object stays stable until the
 * provider swaps hosts, while each retain call gets its own release spy.
 */
interface StreamBindingRecord {
  readonly binding: StreamRuntimeBinding;
  readonly releases: Array<Mock<() => void>>;
}

interface StreamBindingHarness {
  current: StreamBindingRecord | null;
}

const streamBinding = vi.hoisted((): StreamBindingHarness => ({
  current: null,
}));
vi.mock("@/lib/host/stream-runtime-context", () => ({
  useStreamRuntimeBinding: () => streamBinding.current?.binding ?? null,
}));

const invalidateQueriesMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: invalidateQueriesMock }),
}));

import { SessionImportRunController } from "@/components/session-import/session-import-run-controller";
import {
  getSessionImportStartHandle,
  type SessionImportActiveRun,
  type SessionImportRunRequest,
  type SessionImportRunTarget,
} from "@/components/session-import/session-import-run-handle";
import {
  sessionImportRunFor,
  useSessionImportRunStore,
  type SessionImportRunState,
} from "@/stores/session-import/session-import-run-store";
import { sessionImportQueryKeys } from "@/lib/query-keys";

const SELECTION: SessionImportSelection = {
  harness: "claude",
  nativeSessionId: "s1",
};

function activeRun(
  runId: string,
  done: number,
  total: number,
): SessionImportActiveRun {
  return { runId, done, total };
}

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
    notifyCloudVerdictChanged: () => undefined,
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

function createStreamBinding(hostId: string): StreamBindingRecord {
  const releases: Array<Mock<() => void>> = [];
  const binding: StreamRuntimeBinding = {
    wsStreamClient: fakeWsStreamClient(),
    hostId,
    retain: () => {
      const release = vi.fn<() => void>();
      releases.push(release);
      return release;
    },
  };
  return { binding, releases };
}

function currentBindingRecord(): StreamBindingRecord {
  const current = streamBinding.current;
  if (current === null) {
    throw new Error("Expected a current stream binding in this test.");
  }
  return current;
}

function requireRelease(
  record: StreamBindingRecord,
  index: number,
): Mock<() => void> {
  const release = record.releases.at(index);
  if (release === undefined) {
    throw new Error(`Expected a release at index ${index}`);
  }
  return release;
}

/** The target every `start()` call in this suite hands the current binding under. */
function startTarget(): SessionImportRunTarget {
  return targetForBinding(currentBindingRecord().binding);
}

function targetForBinding(
  binding: StreamRuntimeBinding,
): SessionImportRunTarget {
  const hostId = binding.hostId;
  if (hostId === null)
    throw new Error("Expected a bound host id in this test.");
  return {
    binding,
    hostId,
  };
}

function runFor(hostId: string): SessionImportRunState {
  return sessionImportRunFor(useSessionImportRunStore.getState(), hostId);
}

/** The store slice for the host the suite is currently bound to. */
function currentRun(): SessionImportRunState {
  const hostId = currentBindingRecord().binding.hostId;
  if (hostId === null)
    throw new Error("Expected a bound host id in this test.");
  return sessionImportRunFor(useSessionImportRunStore.getState(), hostId);
}

beforeEach(() => {
  streamBinding.current = createStreamBinding("host-a");
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
    expect(requireRelease(currentBindingRecord(), 0)).toHaveBeenCalledTimes(1);
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

  it("subscribes with the permission mode a new chat on that host would get, read when the run starts", () => {
    render(<SessionImportRunController />);
    const handle = getSessionImportStartHandle();
    if (handle === null) {
      throw new Error("Expected a session import start handle.");
    }
    const request: SessionImportRunRequest = {
      selections: [SELECTION],
      titles: new Map([["claude:s1", "My session"]]),
    };

    // No run on this host yet: the install's default, read at subscribe
    // time rather than at mount.
    act(() => {
      useSettingsStore.setState({ defaultPermission: "supervised" });
    });
    act(() => {
      handle.start(request, startTarget());
    });
    expect(requireInstance(1).permissionMode).toBe("supervised");

    // A chat has since run on this host: its mode is what a new chat seeds
    // from, so it is what an import gets too.
    act(() => {
      runClientHarness.instances[1]?.callbacks.onComplete({
        runId: "run-1",
        counts: { imported: 1, skippedAlreadyImported: 0, failed: 0 },
      });
      useComposerRunSettingsStore.getState().setGlobalRunSettings(
        startTarget().hostId,
        {
          harnessId: "claude",
          model: "claude-money",
          permissionMode: "auto_accept_edits",
          reasoningEffort: null,
          serviceTier: null,
          agentMode: "regular",
          profileId: null,
        },
        Date.now(),
      );
    });
    act(() => {
      handle.start(request, startTarget());
    });
    expect(requireInstance(2).permissionMode).toBe("auto_accept_edits");
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
    streamBinding.current = createStreamBinding("host-b");
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

  it("retains an attached ambient run across a host swap and releases its lease once after completion", () => {
    const hostABinding = currentBindingRecord();
    const view = render(<SessionImportRunController />);
    const hostAProbe = requireInstance(0);

    expect(hostABinding.releases).toHaveLength(1);
    const hostALease = requireRelease(hostABinding, 0);
    expect(hostALease).not.toHaveBeenCalled();

    act(() => {
      hostAProbe.callbacks.onStarted({
        attached: true,
        runId: "run-a",
        total: 1,
      });
    });

    const hostBBinding = createStreamBinding("host-b");
    streamBinding.current = hostBBinding;
    view.rerender(<SessionImportRunController />);

    expect(hostALease).not.toHaveBeenCalled();
    expect(hostBBinding.releases).toHaveLength(1);
    const hostBProbe = requireInstance(1);

    act(() => {
      hostAProbe.callbacks.onProgress({
        runId: "run-a",
        index: 0,
        total: 1,
        harness: "claude",
        nativeSessionId: "s1",
        outcome: { kind: "imported", epicId: "epic-a", chatId: "chat-a" },
      });
    });

    const hostAProgress = runFor("host-a");
    expect(hostAProgress.status).toBe("running");
    expect(hostAProgress.outcomes.size).toBe(1);
    expect(runFor("host-b").status).toBe("idle");

    act(() => {
      hostBProbe.callbacks.onStarted({
        attached: true,
        runId: "run-b",
        total: 3,
      });
    });

    act(() => {
      hostAProbe.callbacks.onComplete({
        runId: "run-a",
        counts: { imported: 1, skippedAlreadyImported: 0, failed: 0 },
      });
    });

    const hostAComplete = runFor("host-a");
    expect(hostAComplete.status).toBe("complete");
    expect(hostAComplete.runId).toBe("run-a");
    expect(hostALease).toHaveBeenCalledTimes(1);
    expect(hostBProbe.close).not.toHaveBeenCalled();

    view.unmount();

    // The completed run's release is not repeated by controller unmount. The
    // host-B run gives back its own lease exactly once.
    expect(hostALease).toHaveBeenCalledTimes(1);
    expect(requireRelease(hostBBinding, 0)).toHaveBeenCalledTimes(1);
  });

  it("attaches a scoped target with its lease and keeps progress under that host", () => {
    render(<SessionImportRunController />);
    const scopedBinding = createStreamBinding("host-scoped");
    const handle = getSessionImportStartHandle();
    if (handle === null) {
      throw new Error("Expected a session import start handle.");
    }

    act(() => {
      handle.attach(
        targetForBinding(scopedBinding.binding),
        activeRun("run-scoped", 0, 1),
      );
    });

    expect(runClientHarness.instances).toHaveLength(2);
    expect(requireInstance(1).selections).toEqual([]);
    expect(scopedBinding.releases).toHaveLength(1);
    const scopedRelease = requireRelease(scopedBinding, 0);

    act(() => {
      requireInstance(1).callbacks.onStarted({
        attached: true,
        runId: "run-scoped",
        total: 1,
      });
      requireInstance(1).callbacks.onProgress({
        runId: "run-scoped",
        index: 0,
        total: 1,
        harness: "claude",
        nativeSessionId: "s1",
        outcome: {
          kind: "skipped_already_imported",
          epicId: "epic-scoped",
          chatId: "chat-scoped",
        },
      });
    });

    expect(runFor("host-scoped").status).toBe("running");
    expect(runFor("host-scoped").outcomes.size).toBe(1);

    act(() => {
      requireInstance(1).callbacks.onComplete({
        runId: "run-scoped",
        counts: { imported: 0, skippedAlreadyImported: 1, failed: 0 },
      });
    });

    expect(runFor("host-scoped").status).toBe("complete");
    expect(scopedRelease).toHaveBeenCalledTimes(1);
    expect(requireInstance(1).wsStreamClient).toBe(
      scopedBinding.binding.wsStreamClient,
    );
  });

  it("keeps the status run identity and attached state when an attach disconnects before its first frame", () => {
    render(<SessionImportRunController />);
    const scopedBinding = createStreamBinding("host-scoped");
    const handle = getSessionImportStartHandle();
    if (handle === null) {
      throw new Error("Expected a session import start handle.");
    }

    act(() => {
      handle.attach(
        targetForBinding(scopedBinding.binding),
        activeRun("run-scoped", 2, 4),
      );
    });
    const attach = requireInstance(1);

    const seeded = runFor("host-scoped");
    expect(seeded.status).toBe("running");
    expect(seeded.runId).toBe("run-scoped");
    expect(seeded.total).toBe(4);
    expect(seeded.attached).toBe(true);

    act(() => {
      attach.callbacks.onConnectionStatus("closed", { kind: "caller" });
    });

    const errored = runFor("host-scoped");
    expect(errored.status).toBe("error");
    expect(errored.runId).toBe("run-scoped");
    expect(errored.total).toBe(4);
    expect(errored.attached).toBe(true);
    expect(attach.close).toHaveBeenCalledTimes(1);
    expect(requireRelease(scopedBinding, 0)).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate an existing run when attach is called for its host", () => {
    render(<SessionImportRunController />);
    const probe = requireInstance(0);
    act(() => {
      probe.callbacks.onStarted({
        attached: true,
        runId: "run-1",
        total: 1,
      });
    });
    const handle = getSessionImportStartHandle();
    if (handle === null) {
      throw new Error("Expected a session import start handle.");
    }

    act(() => {
      handle.attach(startTarget(), activeRun("run-1", 0, 1));
    });

    expect(runClientHarness.instances).toHaveLength(1);
  });

  it("replaces an unanswered ambient probe before an attach reports that the run has finished", () => {
    const hostABinding = currentBindingRecord();
    render(<SessionImportRunController />);
    const ambientProbe = requireInstance(0);
    const handle = getSessionImportStartHandle();
    if (handle === null) {
      throw new Error("Expected a session import start handle.");
    }

    act(() => {
      handle.attach(startTarget(), activeRun("run-finished", 0, 1));
    });

    // The wizard's confirmed active status supersedes the unanswered mount
    // probe. The replacement gets its own lease and can receive the final
    // answer without being blocked by the stale probe in the per-host map.
    expect(ambientProbe.close).toHaveBeenCalledTimes(1);
    expect(requireRelease(hostABinding, 0)).toHaveBeenCalledTimes(1);
    expect(runClientHarness.instances).toHaveLength(2);
    const attach = requireInstance(1);
    expect(requireRelease(hostABinding, 1)).not.toHaveBeenCalled();

    act(() => {
      attach.callbacks.onStarted({
        attached: false,
        runId: "run-finished",
        total: 0,
      });
      attach.callbacks.onComplete({
        runId: "run-finished",
        counts: { imported: 1, skippedAlreadyImported: 0, failed: 0 },
      });
    });

    const state = currentRun();
    expect(state.status).toBe("idle");
    expect(state.finalCounts).toBeNull();
    expect(attach.close).toHaveBeenCalledTimes(1);
    expect(requireRelease(hostABinding, 1)).toHaveBeenCalledTimes(1);
    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: sessionImportQueryKeys.status("host-a"),
    });
    expect(invalidateQueriesMock).toHaveBeenCalledTimes(1);
  });

  it("resets an attach whose run finished before the empty reply and ignores its completion", () => {
    render(<SessionImportRunController />);
    const scopedBinding = createStreamBinding("host-scoped");
    const handle = getSessionImportStartHandle();
    if (handle === null) {
      throw new Error("Expected a session import start handle.");
    }

    act(() => {
      handle.attach(
        targetForBinding(scopedBinding.binding),
        activeRun("run-finished", 0, 1),
      );
    });
    const attach = requireInstance(1);
    act(() => {
      attach.callbacks.onStarted({
        attached: false,
        runId: "run-finished",
        total: 0,
      });
      attach.callbacks.onComplete({
        runId: "run-finished",
        counts: { imported: 1, skippedAlreadyImported: 0, failed: 0 },
      });
    });

    const state = runFor("host-scoped");
    expect(state.status).toBe("idle");
    expect(state.finalCounts).toBeNull();
    expect(scopedBinding.releases).toHaveLength(1);
    expect(requireRelease(scopedBinding, 0)).toHaveBeenCalledTimes(1);
    expect(invalidateQueriesMock).toHaveBeenCalledTimes(1);
    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: sessionImportQueryKeys.status("host-scoped"),
    });
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
    expect(requireRelease(currentBindingRecord(), 0)).toHaveBeenCalledTimes(1);
    expect(requireInstance(1).close).not.toHaveBeenCalled();
    expect(requireInstance(1).selections).toEqual([]);
  });

  it("closes the probe on unmount when no answer has arrived yet", () => {
    const { unmount } = render(<SessionImportRunController />);
    const probe = requireInstance(0);

    unmount();

    expect(probe.close).toHaveBeenCalledTimes(1);
    expect(requireRelease(currentBindingRecord(), 0)).toHaveBeenCalledTimes(1);
  });
});
