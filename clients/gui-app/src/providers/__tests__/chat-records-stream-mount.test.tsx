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
import type { ChatRecordDelta } from "@traycer-clients/shared/host-transport/chat-records-stream-client";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import { ChatRecordsStreamMount } from "@/providers/chat-records-stream-mount";

interface StreamState {
  /** One entry per `ChatRecordsStreamClient` construction. */
  readonly opened: Array<{ readonly emit: (delta: ChatRecordDelta) => void }>;
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
        readonly callbacks: { readonly onDelta: (d: ChatRecordDelta) => void };
      }) {
        streamState.opened.push({ emit: options.callbacks.onDelta });
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
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => streamState.hostId,
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

const noopStreamFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

function openEpic(epicId: string): OpenEpicStoreHandle {
  return getOpenEpicRegistry().acquire(epicId, (id) =>
    createOpenEpicStore({
      epicId: id,
      streamClientFactory: noopStreamFactory,
      userId: null,
      onAuthError: null,
    }),
  );
}

function emit(delta: ChatRecordDelta): void {
  const stream = streamState.opened.at(-1);
  if (stream === undefined) throw new Error("no stream opened");
  act(() => {
    stream.emit(delta);
  });
}

afterEach(() => {
  cleanup();
  getOpenEpicRegistry().disposeAll();
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
    const one = openEpic("epic-1");
    const two = openEpic("epic-2");
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
    const handle = openEpic("epic-1");
    handle.store.getState().applyChatRecords([record({ chatId: "gone" })]);
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
    const handle = openEpic("epic-1");
    handle.store.getState().applyChatRecords([record({ chatId: "polled" })]);

    render(<ChatRecordsStreamMount />);

    expect(streamState.opened).toHaveLength(0);
    // The poll's rows are still exactly what the record table holds.
    expect(handle.store.getState().chats.allIds).toEqual(["polled"]);
    handle.store
      .getState()
      .applyChatRecords([
        record({ chatId: "polled" }),
        record({ chatId: "polled-again" }),
      ]);
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
