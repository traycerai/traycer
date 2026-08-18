/**
 * `host.chatRecords.subscribe@1.0`'s typed client.
 *
 * The class owns exactly one thing - turning wire envelopes into typed deltas -
 * so that is what these pin: the two ops arrive intact and in order, control
 * frames are inert, and a frame this build cannot parse is DROPPED rather than
 * guessed at (the removal-reason enum is closed for precisely that reason).
 *
 * Ablation: delete the `safeParse` guard and the unknown-reason case below
 * delivers a `remove` whose reason is a string no consumer has a branch for -
 * a tab that silently renders nothing instead of falling back to the poll.
 */
import { describe, expect, it, vi } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { ChatRecordSummary } from "@traycer/protocol/host/epic/chat-records";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamCloseReason,
  StreamConnectionStatus,
} from "../i-stream-session";
import {
  ChatRecordsStreamClient,
  type ChatRecordDelta,
} from "../chat-records-stream-client";
import { WsStreamClient } from "../ws-stream-client";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";

class StubSession implements IStreamSession {
  private serverFrameHandler: ServerFrameHandler = () => undefined;
  private statusChangeHandler: StatusChangeHandler = () => undefined;
  negotiatedSchemaVersion: SchemaVersion | null = null;

  readonly close = vi.fn();

  sendClientFrame(): void {}

  onServerFrame(handler: ServerFrameHandler): void {
    this.serverFrameHandler = handler;
  }

  onStatusChange(handler: StatusChangeHandler): void {
    this.statusChangeHandler = handler;
  }

  getNegotiatedSchemaVersion(): SchemaVersion | null {
    return this.negotiatedSchemaVersion;
  }

  requestReconnect(): void {}

  emitFrame(frame: Parameters<ServerFrameHandler>[0]): void {
    this.serverFrameHandler(frame, null);
  }

  emitStatus(
    status: Parameters<StatusChangeHandler>[0],
    reason: StreamCloseReason | null,
  ): void {
    this.statusChangeHandler(status, reason);
  }
}

function makeWsStreamClient(
  session: IStreamSession,
): WsStreamClient<typeof hostStreamRpcRegistry> {
  const client = new WsStreamClient({
    registry: hostStreamRpcRegistry,
    endpoint: () => null,
    bearer: () => null,
    auth: null,
    hostCredentialMint: null,
    evidence: NO_TRANSPORT_EVIDENCE,
    webSocketFactory: {
      create: () => {
        throw new Error("unexpected WebSocket creation");
      },
    },
    dialTimeoutMs: 1_000,
    openAckTimeoutMs: 1_000,
    pingIntervalMs: 25_000,
    pongTimeoutMs: 50_000,
    initialBackoffMs: 10,
    maxBackoffMs: 1_000,
  });
  vi.spyOn(client, "subscribe").mockReturnValue(session);
  return client;
}

function row(overrides: Partial<ChatRecordSummary>): ChatRecordSummary {
  return {
    chatId: "chat-1",
    ownerUserId: "user-a",
    originHostId: "host-1",
    title: "A chat",
    isTitleEditedByUser: false,
    parentChatId: null,
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    archivedAt: null,
    runSettingsSummary: "claude",
    revision: 3,
    visibility: "private",
    origin: "own",
    ...overrides,
  };
}

interface StatusCall {
  readonly status: StreamConnectionStatus;
  readonly reason: StreamCloseReason | null;
}

interface Harness {
  readonly session: StubSession;
  readonly deltas: ChatRecordDelta[];
  readonly client: ChatRecordsStreamClient;
  readonly statuses: StatusCall[];
  readonly wsStreamClient: WsStreamClient<typeof hostStreamRpcRegistry>;
}

function harness(): Harness {
  const session = new StubSession();
  const wsStreamClient = makeWsStreamClient(session);
  const deltas: ChatRecordDelta[] = [];
  const statuses: StatusCall[] = [];
  const client = new ChatRecordsStreamClient({
    wsStreamClient,
    callbacks: {
      onDelta: (delta) => deltas.push(delta),
      onConnectionStatus: (status, reason) => statuses.push({ status, reason }),
    },
  });
  return { session, deltas, client, statuses, wsStreamClient };
}

describe("ChatRecordsStreamClient", () => {
  it("subscribes to the host-scoped method with an empty open request", () => {
    const h = harness();
    expect(h.wsStreamClient.subscribe).toHaveBeenCalledWith(
      "host.chatRecords.subscribe",
      {},
    );
    h.client.close();
  });

  it("delivers upsert and remove as typed deltas, each naming its epic", () => {
    const h = harness();
    const record = row({ chatId: "chat-a", revision: 7 });
    h.session.emitFrame({
      kind: "upsert",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-a",
      revision: 7,
      record,
    });
    h.session.emitFrame({
      kind: "remove",
      hasBinaryPayload: false,
      epicId: "epic-2",
      chatId: "chat-b",
      reason: "revoked",
    });

    expect(h.deltas).toEqual([
      { kind: "upsert", epicId: "epic-1", record },
      {
        kind: "remove",
        epicId: "epic-2",
        chatId: "chat-b",
        reason: "revoked",
      },
    ]);
    h.client.close();
  });

  it("carries a FOREIGN row through untouched - origin is host-stated, not re-derived", () => {
    const h = harness();
    const foreign = row({
      chatId: "chat-foreign",
      originHostId: "host-2",
      origin: "foreign",
      visibility: "task",
      archived: true,
      // The shape a foreign archived row really has: the cloud row carries the
      // boolean and no timestamp, so anything deriving archived-ness from
      // `archivedAt` alone would read this as active.
      archivedAt: null,
    });
    h.session.emitFrame({
      kind: "upsert",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-foreign",
      revision: foreign.revision,
      record: foreign,
    });

    expect(h.deltas).toEqual([
      { kind: "upsert", epicId: "epic-1", record: foreign },
    ]);
    h.client.close();
  });

  it("drops a frame this build cannot parse instead of guessing at it", () => {
    const h = harness();
    // A removal reason from a later, widened minor. The enum is CLOSED, so the
    // honest answer is to deliver nothing and let the poll - which still sees
    // the row leave the host's list - keep the table correct.
    h.session.emitFrame({
      kind: "remove",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-a",
      reason: "quarantined",
    });
    // A malformed upsert (no row) is the same class of answer.
    h.session.emitFrame({
      kind: "upsert",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-a",
      revision: 1,
    });
    expect(h.deltas).toEqual([]);
    h.client.close();
  });

  it("treats pong as inert - the transport owns the heartbeat", () => {
    const h = harness();
    h.session.emitFrame({ kind: "pong", hasBinaryPayload: false });
    expect(h.deltas).toEqual([]);
    h.client.close();
  });

  it("reports connection status and closes its session idempotently", () => {
    const h = harness();
    const reason: StreamCloseReason = { kind: "caller" };
    h.session.emitStatus("reconnecting", null);
    h.session.emitStatus("closed", reason);
    expect(h.statuses).toEqual([
      { status: "reconnecting", reason: null },
      { status: "closed", reason },
    ]);

    h.client.close();
    h.client.close();
    expect(h.session.close).toHaveBeenCalledTimes(1);
  });
});
