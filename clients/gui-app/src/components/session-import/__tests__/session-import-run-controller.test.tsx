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
import type {
  SessionImportRunCallbacks,
  SessionImportRunClientOptions,
} from "@traycer-clients/shared/host-transport/session-import-run-client";

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
} from "@/components/session-import/session-import-run-handle";
import { useSessionImportRunStore } from "@/stores/session-import/session-import-run-store";

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

beforeEach(() => {
  streamBinding.client = { stream: "test" };
  streamBinding.hostId = "host-a";
  runClientHarness.instances = [];
  invalidateQueriesMock.mockClear();
  useSessionImportRunStore.getState().reset();
});

afterEach(() => {
  cleanup();
  useSessionImportRunStore.getState().reset();
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
    expect(useSessionImportRunStore.getState().status).toBe("idle");
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
    const afterStarted = useSessionImportRunStore.getState();
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

    expect(useSessionImportRunStore.getState().outcomes.size).toBe(1);

    act(() => {
      probe.callbacks.onComplete({
        runId: "run-1",
        counts: { imported: 1, skippedAlreadyImported: 0, failed: 0 },
      });
    });

    const afterComplete = useSessionImportRunStore.getState();
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
      handle.start(request);
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
      handle.start(request);
    });

    // The probe was only asking; the click must not be dropped for it. If a
    // run WAS in flight, this subscribe attaches to it just as the probe
    // would have.
    expect(probe.close).toHaveBeenCalledTimes(1);
    expect(runClientHarness.instances).toHaveLength(2);
    expect(requireInstance(1).selections).toEqual([SELECTION]);
    expect(useSessionImportRunStore.getState().status).toBe("starting");
  });

  it("probes the new host once a run retained across a host swap closes", () => {
    const view = render(<SessionImportRunController />);
    const firstProbe = requireInstance(0);
    act(() => {
      firstProbe.callbacks.onStarted({
        attached: true,
        runId: "run-1",
        total: 2,
      });
    });

    // The app is pointed at another host while host-a's run is still going.
    // That run keeps the client slot, so the new host is not asked yet.
    streamBinding.client = { stream: "test-b" };
    streamBinding.hostId = "host-b";
    view.rerender(<SessionImportRunController />);
    expect(runClientHarness.instances).toHaveLength(1);

    act(() => {
      firstProbe.callbacks.onComplete({
        runId: "run-1",
        counts: { imported: 2, skippedAlreadyImported: 0, failed: 0 },
      });
    });

    // Host-a's run closing is what frees the slot, and the new binding has
    // never been asked - so it is asked now, finished summary or not.
    expect(runClientHarness.instances).toHaveLength(2);
    const secondProbe = requireInstance(1);
    expect(secondProbe.selections).toEqual([]);
    act(() => {
      secondProbe.callbacks.onStarted({
        attached: true,
        runId: "run-2",
        total: 3,
      });
    });
    const state = useSessionImportRunStore.getState();
    expect(state.runId).toBe("run-2");
    expect(state.status).toBe("running");
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
      handle.start({
        selections: [SELECTION],
        titles: new Map([["claude:s1", "My session"]]),
      });
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
