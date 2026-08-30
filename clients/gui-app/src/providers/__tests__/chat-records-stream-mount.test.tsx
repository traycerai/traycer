/**
 * The record-change PUSH stream's mount (multi-host-chats record layer).
 *
 * Three things live here and nowhere else: WHEN a subscription is opened at
 * all (the degrade arm), WHERE a delta is routed (frames name their epic; the
 * subscription is host-scoped), and WHAT happens to a delta for an epic nobody
 * has open. The stream client itself is exercised in
 * `clients/shared/host-transport/__tests__/chat-records-stream-client.test.ts`;
 * here it is stubbed at the class boundary so a delta can be emitted by hand.
 *
 * The open-epic sessions are REAL, so a delta that reaches one is asserted by
 * reading the record table it was supposed to change - the same table
 * `epic.listChatRecords` fills.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { ChatRecordSummary } from "@traycer/protocol/host/epic/chat-records";
import type { TuiAgentRecordSummaryV12 } from "@traycer/protocol/host/epic/tui-agent-records";
import type { ChatRecordsStreamDelta } from "@traycer-clients/shared/host-transport/chat-records-stream-client";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import {
  hostConnectionRefCountForTest,
  resetHostConnectionRegistryForTest,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import { HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS } from "@traycer-clients/shared/host-client/host-connection-reconnect-engine";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import {
  getOpenEpicRegistry,
  handleHostIds,
} from "@/lib/registries/epic-session-registry";
import { ChatRecordsStreamMount } from "@/providers/chat-records-stream-mount";

interface OpenedStream {
  readonly emit: (delta: ChatRecordsStreamDelta) => void;
  readonly emitStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

interface StreamState {
  /** One entry per `ChatRecordsStreamClient` construction. */
  readonly opened: Array<OpenedStream>;
  closes: number;
  support: StreamMethodSupport | null;
  hostId: string | null;
  hasClient: boolean;
}

const streamState = vi.hoisted((): StreamState => ({
  opened: [],
  closes: 0,
  support: "supported",
  hostId: "host-A",
  hasClient: true,
}));

/**
 * ONE stable client object across renders. The mount keys its effect on the
 * client's identity, so a mock that minted `{ stub: true }` per render would
 * re-run the effect on EVERY rerender - and the host-change test below could
 * then pass because the client changed, not because `hostId` did.
 */
const stubWsStreamClient = vi.hoisted((): { readonly stub: true } => ({
  stub: true,
}));

vi.mock(
  "@traycer-clients/shared/host-transport/chat-records-stream-client",
  () => ({
    ChatRecordsStreamClient: class {
      constructor(options: {
        readonly callbacks: {
          readonly onDelta: (d: ChatRecordsStreamDelta) => void;
          readonly onConnectionStatus: (
            status: StreamConnectionStatus,
            reason: StreamCloseReason | null,
          ) => void;
        };
      }) {
        streamState.opened.push({
          emit: options.callbacks.onDelta,
          emitStatus: options.callbacks.onConnectionStatus,
        });
      }
      close(): void {
        streamState.closes += 1;
      }
    },
  }),
);

vi.mock("@/lib/host/stream-runtime-context", () => ({
  // Only its NULL-ness is read by the mount; the stub client is handed to the
  // stubbed stream class above, which ignores it. Referentially stable on
  // purpose - see `stubWsStreamClient`.
  useWsStreamClient: () => (streamState.hasClient ? stubWsStreamClient : null),
  useStreamMethodSupport: () => streamState.support,
  // The mount now reads its host id off the SAME `StreamRuntimeBinding` as
  // the client (`useStreamHostId`), not the separately-updating
  // `useAddressableHostId` - so the stub lives on this mock, not a second one.
  useStreamHostId: () => streamState.hostId,
}));

function record(overrides: Partial<ChatRecordSummary>): ChatRecordSummary {
  return {
    chatId: "chat-1",
    ownerUserId: "user-a",
    originHostId: "host-A",
    title: "A chat",
    isTitleEditedByUser: false,
    parentChatId: null,
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    archivedAt: null,
    runSettingsSummary: "claude",
    revision: 1,
    visibility: "private",
    origin: "own",
    ...overrides,
  };
}

function tuiRecord(
  overrides: Partial<Extract<TuiAgentRecordSummaryV12, { origin: "registry" }>>,
): Extract<TuiAgentRecordSummaryV12, { origin: "registry" }> {
  return {
    tuiAgentId: "tui-1",
    ownerUserId: "user-a",
    hostId: "host-A",
    harnessId: "claude",
    harnessSessionId: null,
    parentId: null,
    title: "An agent",
    isTitleEditedByUser: false,
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    archivedAt: null,
    workspaceFolders: [],
    workspaceMode: null,
    model: null,
    reasoningEffort: null,
    agentMode: "regular",
    profileId: null,
    terminalAgentArgs: null,
    terminalShellCommand: null,
    terminalShellArgs: null,
    revision: 1,
    // This suite tests the mount's host-stamp routing gate, not doc
    // residency - an ordinary registry row exercises it.
    docResident: false,
    origin: "registry",
    ...overrides,
  };
}

const noopStreamFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

/**
 * `hostId` is explicit at every call because it is load-bearing: the mount
 * applies a delta only to a session stamped with the stream's own host, which
 * `epic-session-provider.tsx` does for every handle it creates. A helper that
 * defaulted it would hide the one input the routing gate reads.
 */
function openEpic(epicId: string, hostId: string | null): OpenEpicStoreHandle {
  const handle = getOpenEpicRegistry().acquire(epicId, (id) =>
    createOpenEpicStore({
      epicId: id,
      streamClientFactory: noopStreamFactory,
      userId: null,
      onAuthError: null,
    }),
  );
  handleHostIds.set(handle, hostId);
  return handle;
}

function emit(delta: ChatRecordsStreamDelta): void {
  const stream = streamState.opened.at(-1);
  if (stream === undefined) throw new Error("no stream opened");
  act(() => {
    stream.emit(delta);
  });
}

function emitStatus(
  status: StreamConnectionStatus,
  reason: StreamCloseReason | null,
): void {
  const stream = streamState.opened.at(-1);
  if (stream === undefined) throw new Error("no stream opened");
  act(() => {
    stream.emitStatus(status, reason);
  });
}

function fatalClose(code: string): StreamCloseReason {
  return {
    kind: "fatalError",
    details: {
      code,
      reason: `test close: ${code}`,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

afterEach(() => {
  cleanup();
  getOpenEpicRegistry().disposeAll();
  resetHostConnectionRegistryForTest();
  streamState.opened.length = 0;
  streamState.closes = 0;
  streamState.support = "supported";
  streamState.hostId = "host-A";
  streamState.hasClient = true;
});

describe("<ChatRecordsStreamMount />", () => {
  it("opens exactly one host-scoped subscription and closes it on unmount", () => {
    const { unmount } = render(<ChatRecordsStreamMount />);
    expect(streamState.opened).toHaveLength(1);
    unmount();
    expect(streamState.closes).toBe(1);
  });

  it("routes an upsert into the named epic's record table, leaving the other alone", () => {
    const one = openEpic("epic-1", "host-A");
    const two = openEpic("epic-2", "host-A");
    render(<ChatRecordsStreamMount />);

    emit({
      kind: "upsert",
      epicId: "epic-1",
      record: record({ chatId: "pushed", title: "Pushed" }),
    });

    expect(one.store.getState().chats.byId.pushed.title).toBe("Pushed");
    // Frames name their epic precisely BECAUSE one subscription covers them
    // all; a mount that ignored `epicId` would put every host's delta in every
    // open epic.
    expect(two.store.getState().chats.allIds).toEqual([]);
  });

  it("routes a remove, and the retraction reason with it", () => {
    const handle = openEpic("epic-1", "host-A");
    handle.store
      .getState()
      .applyChatRecords([record({ chatId: "gone" })], null);
    render(<ChatRecordsStreamMount />);

    emit({
      kind: "remove",
      epicId: "epic-1",
      chatId: "gone",
      reason: "revoked",
    });

    expect(handle.store.getState().chats.allIds).toEqual([]);
    expect(handle.store.getState().chatRetractions).toEqual({
      gone: "revoked",
    });
  });

  it("drops a delta for a session bound to a DIFFERENT host than the stream", () => {
    // The A/B case: this subscription is dialling host-A (`streamState.hostId`)
    // while the open session is still pinned to host-B - a re-point in flight,
    // or a tab reopened on its original host. B's session must not ingest A's
    // rows: the record does not exist on B's plane, and every affordance the
    // row renders would address the wrong host.
    //
    // Ablation: drop the stamp comparison in the mount and both assertions
    // below flip - the row lands, and the terminal agent with it.
    const foreign = openEpic("epic-1", "host-B");
    render(<ChatRecordsStreamMount />);

    emit({
      kind: "upsert",
      epicId: "epic-1",
      record: record({ chatId: "from-host-a" }),
    });
    // The terminal-agent frame too, so the assertion on its table is about
    // the GATE and not about a table nothing ever wrote to.
    emit({
      kind: "tuiUpsert",
      epicId: "epic-1",
      record: tuiRecord({ tuiAgentId: "tui-from-host-a" }),
    });

    expect(foreign.store.getState().chats.allIds).toEqual([]);
    // Same gate for both tables, not just the terminal-agent arm.
    expect(foreign.store.getState().tuiAgentRecords.allIds).toEqual([]);
  });

  it("routes a delta once the session's stamp matches the stream's host", () => {
    // The positive control for the test above: same epic, same frame, and the
    // only difference is which host the session is stamped with - so the drop
    // above is attributable to the stamp and not to some unrelated gate.
    const bound = openEpic("epic-1", "host-A");
    render(<ChatRecordsStreamMount />);

    emit({
      kind: "upsert",
      epicId: "epic-1",
      record: record({ chatId: "from-host-a" }),
    });
    emit({
      kind: "tuiUpsert",
      epicId: "epic-1",
      record: tuiRecord({ tuiAgentId: "tui-from-host-a" }),
    });

    expect(bound.store.getState().chats.allIds).toEqual(["from-host-a"]);
    expect(bound.store.getState().tuiAgentRecords.allIds).toEqual([
      "tui-from-host-a",
    ]);
  });

  it("drops a delta for an epic with no live session rather than acquiring one", () => {
    render(<ChatRecordsStreamMount />);

    emit({
      kind: "upsert",
      epicId: "epic-closed",
      record: record({ chatId: "chat-x" }),
    });

    // Constructing a session (Y.Doc replica + stream) because a record changed
    // in an epic nobody is looking at is exactly the background work the
    // open-epic sync scope rules out. The epic re-reads the whole list on open.
    expect(getOpenEpicRegistry().peek("epic-closed")).toBeNull();
    expect(getOpenEpicRegistry().size()).toBe(0);
  });

  it("opens NOTHING when the host does not support the method - the poll carries on alone", () => {
    // The whole degrade contract: a host predating the stream never advertises
    // it, so there is no subscription, no error, and no empty state. The 20s
    // `epic.listChatRecords` poll is untouched by this component and remains
    // the record table's only refresh.
    //
    // Ablation: drop the `support === "unsupported"` arm and the mount dials a
    // method the host will refuse on every reconnect.
    streamState.support = "unsupported";
    const handle = openEpic("epic-1", "host-A");
    handle.store
      .getState()
      .applyChatRecords([record({ chatId: "polled" })], null);

    render(<ChatRecordsStreamMount />);

    expect(streamState.opened).toHaveLength(0);
    // The poll's rows are still exactly what the record table holds.
    expect(handle.store.getState().chats.allIds).toEqual(["polled"]);
    handle.store
      .getState()
      .applyChatRecords(
        [record({ chatId: "polled" }), record({ chatId: "polled-again" })],
        null,
      );
    expect(handle.store.getState().chats.allIds.slice().sort()).toEqual([
      "polled",
      "polled-again",
    ]);
  });

  it("waits for a transport and a bound host before subscribing", () => {
    streamState.hasClient = false;
    const first = render(<ChatRecordsStreamMount />);
    expect(streamState.opened).toHaveLength(0);
    first.unmount();

    streamState.hasClient = true;
    streamState.hostId = null;
    const second = render(<ChatRecordsStreamMount />);
    expect(streamState.opened).toHaveLength(0);
    second.unmount();
  });

  it("re-subscribes when the active host changes, so a previous host's rows cannot leak", () => {
    const view = render(<ChatRecordsStreamMount />);
    expect(streamState.opened).toHaveLength(1);

    streamState.hostId = "host-B";
    view.rerender(<ChatRecordsStreamMount />);

    expect(streamState.closes).toBe(1);
    expect(streamState.opened).toHaveLength(2);
  });
});

/**
 * The reopen lane: a terminal close used to leave this mount's subscription
 * dead until reload (new agents stopped appearing until the 20s poll's next
 * success, or not at all while the poll was failing too). It now opens a
 * reopen lane on the host's shared reconnect engine, mirroring the
 * notification-family stores (`notifications-session-provider.test.tsx`'s
 * "reopens activity after a recoverable terminal close").
 */
describe("<ChatRecordsStreamMount /> reopen lane", () => {
  it("rebuilds the client after a reopenable terminal close, once the backoff elapses", () => {
    vi.useFakeTimers();
    try {
      render(<ChatRecordsStreamMount />);
      expect(streamState.opened).toHaveLength(1);

      emitStatus("closed", fatalClose("UNAUTHORIZED"));
      // Not yet - the reopen lane waits out its backoff first.
      expect(streamState.opened).toHaveLength(1);

      act(() => {
        vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS);
      });
      expect(streamState.opened).toHaveLength(2);
      expect(streamState.closes).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reopen after a non-reopenable close (CLIENT_CLOSED)", () => {
    vi.useFakeTimers();
    try {
      render(<ChatRecordsStreamMount />);
      expect(streamState.opened).toHaveLength(1);

      emitStatus("closed", fatalClose("CLIENT_CLOSED"));
      act(() => {
        vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS * 10);
      });
      expect(streamState.opened).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("disposes the reopen lane and releases the host connection on unmount", () => {
    vi.useFakeTimers();
    try {
      const { unmount } = render(<ChatRecordsStreamMount />);
      expect(streamState.opened).toHaveLength(1);
      expect(hostConnectionRefCountForTest("host-A")).toBe(1);

      emitStatus("closed", fatalClose("UNAUTHORIZED"));
      unmount();
      expect(hostConnectionRefCountForTest("host-A")).toBe(0);

      // The reopen timer was armed but not yet fired; disposal on unmount
      // must cancel it rather than let it construct a client for an unmounted
      // mount.
      act(() => {
        vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS * 10);
      });
      expect(streamState.opened).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets the reopen lane's backoff after a close that followed a healthy (>=30s open) session", () => {
    // HEALTHY_SESSION_RESET_MS is module-local (30_000) - not exported, so
    // pinned here by literal value, same as the provisioning ladder's
    // private constants above.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      render(<ChatRecordsStreamMount />);
      expect(streamState.opened).toHaveLength(1);

      // First close never reported "open" at all, so it is not healthy - the
      // lane's backoff is untouched (still its initial 5s) for THIS
      // schedule, then doubles to 10s for the next one.
      emitStatus("closed", fatalClose("UNAUTHORIZED"));
      act(() => {
        vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS);
      });
      expect(streamState.opened).toHaveLength(2);

      // Second client: report "open", let it dwell >= 30s, then close.
      emitStatus("open", null);
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      emitStatus("closed", fatalClose("UNAUTHORIZED"));

      // Without the healthy-dwell reset this close would inherit the doubled
      // 10s backoff from the first close - advancing only the INITIAL 5s
      // here is what proves the reset happened.
      act(() => {
        vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS);
      });
      expect(streamState.opened).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reset the reopen lane's backoff after a quick (<30s) close", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      render(<ChatRecordsStreamMount />);
      expect(streamState.opened).toHaveLength(1);

      // First close (also not healthy): schedules at the initial 5s, then
      // doubles to 10s for the next one.
      emitStatus("closed", fatalClose("UNAUTHORIZED"));
      act(() => {
        vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS);
      });
      expect(streamState.opened).toHaveLength(2);

      // Second client: opens, but closes almost immediately - well under the
      // 30s healthy dwell - so the backoff must NOT reset.
      emitStatus("open", null);
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      emitStatus("closed", fatalClose("UNAUTHORIZED"));

      // The doubled 10s backoff is still in force: the initial 5s alone is
      // not enough to reopen.
      act(() => {
        vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS);
      });
      expect(streamState.opened).toHaveLength(2);

      // The remaining 5s completes the 10s window.
      act(() => {
        vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS);
      });
      expect(streamState.opened).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
