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
/**
 * A `getQueryData` seam that the `auto` gate no longer uses, kept deliberately
 * as a TRIPWIRE rather than deleted with the read it once served. The real
 * module is mocked wholesale below for `invalidateQueries` already, so this is
 * a second mocked member on the same seam rather than a real `QueryClient`.
 *
 * `value` is answered to EVERY read regardless of key, so a gate that consults
 * the cache for anything finds a catalog row saying `auto`. `keys` records
 * what was asked for, and "demotes auto when the negotiated version is below
 * the auto line, and never reads the query cache to decide it" asserts it
 * stays EMPTY - which is how the removal of the cross-method catalog read
 * stays removed. Without that assertion this harness would be inert: nothing
 * reads it, and re-adding a cache read would redden nothing.
 */
const queryDataHarness = vi.hoisted(() => ({
  value: undefined as ListGuiHarnessesResponse | undefined,
  keys: [] as unknown[],
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: invalidateQueriesMock,
    getQueryData: (queryKey: unknown) => {
      queryDataHarness.keys.push(queryKey);
      return queryDataHarness.value;
    },
  }),
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
import { sessionImportRunV12 } from "@traycer/protocol/host/session-import/run";
import type { ListGuiHarnessesResponse } from "@traycer/protocol/host/index";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";

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
  return createStreamBindingWithWsClient(hostId, fakeWsStreamClient());
}

/**
 * A stream binding whose `sessionImport.run` version is `version` rather than
 * the honest-stub's always-`null`.
 *
 * This is the ONLY seam the gate reads. Both of its facts - a live session's
 * negotiated line, and the line the host advertised in its stream handshake -
 * arrive through `getMethodSchemaVersion`, so a fixture cannot tell them
 * apart and does not need to. The unary negotiated manifest is deliberately
 * not used: `sessionImport.run` is a stream method and never appears in it.
 */
function createStreamBindingWithSchemaVersion(
  hostId: string,
  version: { readonly major: number; readonly minor: number },
): StreamBindingRecord {
  return createStreamBindingWithWsClient(hostId, {
    ...fakeWsStreamClient(),
    getMethodSchemaVersion: () => version,
  });
}

function createStreamBindingWithWsClient(
  hostId: string,
  wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>,
): StreamBindingRecord {
  const releases: Array<Mock<() => void>> = [];
  const binding: StreamRuntimeBinding = {
    wsStreamClient,
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
  queryDataHarness.value = undefined;
  queryDataHarness.keys = [];
  useSessionImportRunStore.setState({ runs: new Map() });
});

afterEach(() => {
  cleanup();
  useSessionImportRunStore.setState({ runs: new Map() });
  // `negotiated-manifest-registry` is MODULE-LEVEL state shared across every
  // test in the process, not something `vi.mock` resets between cases - a
  // manifest recorded by one "auto permission-mode gate" case would otherwise
  // leak into the next one keyed by the same host id.
  resetNegotiatedManifests();
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

  describe("the auto permission-mode gate", () => {
    it("demotes a sticky auto default to auto_accept_edits when the host has proven nothing", () => {
      streamBinding.current = createStreamBinding("host-auto-unproven");
      useSettingsStore.setState({ defaultPermission: "auto" });
      render(<SessionImportRunController />);
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

      expect(requireInstance(1).permissionMode).toBe("auto_accept_edits");
    });

    it("sends auto unchanged when the negotiated sessionImport.run version proves the host knows it", () => {
      streamBinding.current = createStreamBindingWithSchemaVersion(
        "host-auto-negotiated",
        sessionImportRunV12.schemaVersion,
      );
      useSettingsStore.setState({ defaultPermission: "auto" });
      render(<SessionImportRunController />);
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

      expect(requireInstance(1).permissionMode).toBe("auto");
    });

    it("sends auto unchanged when the host's ADVERTISED sessionImport.run line proves it, with no live session", () => {
      // The advertised line, which reaches this gate through the SAME
      // accessor the live session does: `WsStreamClient.applyHostManifest`
      // caches what a subscribe would declare for every method in the peer
      // manifest, and `getMethodSchemaVersion` falls through to that cache.
      //
      // This used to pin `recordNegotiatedHostManifest` instead, and that was
      // the defect wearing a test: the unary manifest is derived from the
      // unary registry alone, `sessionImport.run` is a stream method, so the
      // key this wrote by hand is one no host can ever publish. The assertion
      // passed while production read `null` and demoted every import.
      streamBinding.current = createStreamBindingWithSchemaVersion(
        "host-auto-cached",
        sessionImportRunV12.schemaVersion,
      );
      useSettingsStore.setState({ defaultPermission: "auto" });
      render(<SessionImportRunController />);
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

      expect(requireInstance(1).permissionMode).toBe("auto");
    });

    // A remote host needs no live `sessionImport.run` session for this to
    // answer: `getMethodSchemaVersion` reports the line the host ADVERTISED
    // in its stream handshake when no session has negotiated one, and both
    // transports supply that - `WsStreamClient` caches a declarable version
    // for every method in the peer manifest, and `RemoteSession` installs the
    // peer manifest from its own `openAck`. What opens a stream here before
    // any import is the wizard's `sessionImport.scan` subscription, on this
    // same binding's client.
    //
    // These two cases pin that for a host shaped like the wizard's remote
    // import target rather than the ambient one this controller otherwise
    // runs against. No RPC, no catalog and no unary manifest is involved.
    it("opens with permissionMode 'auto' for a remote-shaped host whose advertised sessionImport.run line proves it", () => {
      streamBinding.current = createStreamBindingWithSchemaVersion(
        "host-remote-import-target",
        sessionImportRunV12.schemaVersion,
      );
      useSettingsStore.setState({ defaultPermission: "auto" });

      render(<SessionImportRunController />);
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

      expect(requireInstance(1).permissionMode).toBe("auto");
    });

    it("demotes to 'auto_accept_edits' for a remote-shaped host with no sessionImport.run line known", () => {
      streamBinding.current = createStreamBinding(
        "host-remote-import-target-empty",
      );
      useSettingsStore.setState({ defaultPermission: "auto" });
      // `createStreamBinding`'s stub answers `null` for every method, which is
      // a host whose stream handshake has not happened or did not come back -
      // the same answer as a host too old to advertise the line at all.
      render(<SessionImportRunController />);
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

      expect(requireInstance(1).permissionMode).toBe("auto_accept_edits");
    });

    it("never touches a non-auto default even when the host has proven nothing", () => {
      streamBinding.current = createStreamBinding("host-auto-not-relevant");
      useSettingsStore.setState({ defaultPermission: "full_access" });
      render(<SessionImportRunController />);
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

      expect(requireInstance(1).permissionMode).toBe("full_access");
    });

    // `hostUnderstandsAutoPermissionMode` reads ONE accessor,
    // `getMethodSchemaVersion`, which answers from a live session's negotiated
    // line when one exists and from the host's advertised line otherwise. The
    // cases below vary that single answer: at the required line, above it,
    // below it, on a higher major, and absent.
    //
    // The comparison requires an EXACT major match with `minor >=` inside it,
    // so a HIGHER major demotes exactly like a lower one - it is a line this
    // build cannot reason about, not evidence of support.
    //
    // This is what replaced `handshakeProvesPreAutoCatalog`, a veto that sat
    // in front of a cached `agent.gui.listHarnesses` row. Both are gone: a
    // catalog fact is a different method's fact, which is the rule the
    // catalog broke.
    describe("the sessionImport.run line the gate reads", () => {
      it("sends auto for an advertised sessionImport.run manifest at or above the required minor", () => {
        // A higher minor within the same major, not the exact required
        // version - proves the `>=` half of the comparison independently of
        // the exact-match case covered by "host-auto-cached" above.
        streamBinding.current = createStreamBindingWithSchemaVersion(
          "host-auto-manifest-at-line",
          {
            major: sessionImportRunV12.schemaVersion.major,
            minor: sessionImportRunV12.schemaVersion.minor + 3,
          },
        );
        useSettingsStore.setState({ defaultPermission: "auto" });
        render(<SessionImportRunController />);
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

        // FALSIFICATION: change the version check's minor comparison from
        // `>=` to `===` and this goes red - a host that has moved past the
        // required minor within the same major still understands `auto`.
        expect(requireInstance(1).permissionMode).toBe("auto");
        // The cache tripwire on the FALL-THROUGH path. Its sibling in "never
        // reads the query cache to decide it" cannot cover this: that case's
        // negotiated version is below the line, so the gate returns before it
        // ever reaches the manifest branch - which is precisely where the
        // removed `agent.gui.listHarnesses` read used to sit. This case has a
        // `null` negotiated version, so it runs the whole function.
        expect(queryDataHarness.keys).toEqual([]);
      });

      it("demotes when the advertised sessionImport.run manifest is below the required minor", () => {
        streamBinding.current = createStreamBindingWithSchemaVersion(
          "host-auto-manifest-below",
          {
            major: sessionImportRunV12.schemaVersion.major,
            minor: sessionImportRunV12.schemaVersion.minor - 1,
          },
        );
        useSettingsStore.setState({ defaultPermission: "auto" });
        render(<SessionImportRunController />);
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

        expect(requireInstance(1).permissionMode).toBe("auto_accept_edits");
      });

      it("demotes when no sessionImport.run manifest has been recorded for this host", () => {
        streamBinding.current = createStreamBinding(
          "host-auto-manifest-missing",
        );
        useSettingsStore.setState({ defaultPermission: "auto" });
        // The stub answers `null`, so neither a live session nor an advertised
        // line proves anything here and the gate must fail closed rather than
        // assume support.
        render(<SessionImportRunController />);
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

        expect(requireInstance(1).permissionMode).toBe("auto_accept_edits");
      });
    });

    // RPC versions are negotiated PER METHOD (root AGENTS.md): a completed
    // `sessionImport.run` handshake is authoritative on `sessionImport.run`
    // in both directions, and no other method's fact may override it.
    //
    // This started as "a cached `agent.gui.listHarnesses` row must not
    // override the negotiated version". That framing is now obsolete in the
    // strongest possible way: the gate does not consult the catalog - or the
    // query cache at all - on this path any more, so there is no override
    // left to lose to. The catalog row below is therefore a NEGATIVE control,
    // seeded to say `auto` precisely so it can be shown to change nothing,
    // and the recorded-keys assertion is what turns "the catalog is not
    // evidence" from a comment into something that can fail.
    describe("the negotiated sessionImport.run version is authoritative", () => {
      it("demotes auto when the negotiated version is below the auto line, and never reads the query cache to decide it", () => {
        streamBinding.current = createStreamBindingWithSchemaVersion(
          "host-auto-negotiated-below-cached-auto",
          { major: 1, minor: 1 },
        );
        useSettingsStore.setState({ defaultPermission: "auto" });
        const response: ListGuiHarnessesResponse = {
          harnesses: [
            {
              id: "claude",
              label: "Claude Code",
              enabled: true,
              available: true,
              error: null,
              modes: ["gui", "tui"],
              requiresApiKey: false,
              supportedPermissionModes: [
                "supervised",
                "auto_accept_edits",
                "auto",
                "full_access",
              ],
              nativeAutoJudge: false,
              availabilityPending: false,
            },
          ],
        };
        queryDataHarness.value = response;
        render(<SessionImportRunController />);
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

        // FALSIFICATION: delete the
        // `if (versionIsBelow(negotiated, required)) return false;` line and
        // this goes red - a negotiated `1.1` that cannot parse `auto` would
        // fall through to the manifest and send it anyway.
        expect(requireInstance(1).permissionMode).toBe("auto_accept_edits");
        // The catalog row seeded above is answered to EVERY `getQueryData`
        // key, so if the gate read the cache at all it would find an `auto`
        // row. It reads nothing: the decision comes from `sessionImport.run`'s
        // own line, through `getMethodSchemaVersion` and nothing else.
        //
        // FALSIFICATION: restore any `queryClient.getQueryData(...)` read to
        // `hostUnderstandsAutoPermissionMode` and this goes red even if the
        // demotion above still holds - which is the point, since that is the
        // cross-method inference the round removed and nothing else notices
        // its return.
        expect(queryDataHarness.keys).toEqual([]);
      });

      // Control for the case above: at the `auto` line itself, negotiated
      // proof still wins outright.  Already covered by "sends auto unchanged
      // when the negotiated sessionImport.run version proves the host knows
      // it" above (negotiated === sessionImportRunV12.schemaVersion, i.e.
      // {major:1,minor:2}) - not duplicated here.

      // A HIGHER major on `sessionImport.run` is not evidence of support.
      //
      // This case used to assert the opposite: that a live session on a higher
      // major fell through to an advertised manifest pinned at the required
      // major, and still sent `auto`. That state cannot exist. Both facts
      // describe one host's one `sessionImport.run` line, so a host on major 2
      // does not simultaneously advertise major 1 - the fixture could only
      // build it because its second fact came from a registry no host writes.
      //
      // With both facts arriving through the same accessor, a higher major is
      // simply a line this build cannot reason about, and the gate demotes.
      // That is the safe direction and the one the comparison already
      // encodes: `advertised.major === required.major` was never true for it.
      it("demotes when the sessionImport.run line is on a higher major this build cannot reason about", () => {
        streamBinding.current = createStreamBindingWithSchemaVersion(
          "host-auto-negotiated-higher-major",
          { major: sessionImportRunV12.schemaVersion.major + 1, minor: 0 },
        );
        useSettingsStore.setState({ defaultPermission: "auto" });
        render(<SessionImportRunController />);
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

        // FALSIFICATION: make the same-major check a `>=` on major alone and
        // this goes red with 'auto' - a host on the next major would then be
        // credited with understanding a mode nothing has proven it parses.
        expect(requireInstance(1).permissionMode).toBe("auto_accept_edits");
      });

      // The LIVE-session half of the exact-major rule, which the case above
      // cannot pin: there the manifest answers `true` regardless, so relaxing
      // `negotiated.major === required.major` to `>=` changes nothing. Here
      // there is no manifest at all, so the negotiated read is the only thing
      // that could return `true` - and it must not, because a higher major is
      // a DIFFERENT wire contract, not a newer one.
      //
      // The minor deliberately clears the required floor. With `minor: 0` a
      // relaxed `>=` would still fail the minor comparison and demote anyway,
      // so the case would assert against its own input and pin nothing - the
      // same trap the higher-major manifest fixture fell into.
      it("demotes when the negotiated sessionImport.run version is on a higher major and no manifest proves it", () => {
        streamBinding.current = createStreamBindingWithSchemaVersion(
          "host-auto-negotiated-higher-major-unproven",
          {
            major: sessionImportRunV12.schemaVersion.major + 1,
            minor: sessionImportRunV12.schemaVersion.minor + 1,
          },
        );
        useSettingsStore.setState({ defaultPermission: "auto" });
        render(<SessionImportRunController />);
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

        // FALSIFICATION: relax the live-session check to
        // `negotiated.major >= required.major` and this goes red with 'auto' -
        // the import would ride a major this client has never negotiated.
        expect(requireInstance(1).permissionMode).toBe("auto_accept_edits");
      });
    });
  });
});
