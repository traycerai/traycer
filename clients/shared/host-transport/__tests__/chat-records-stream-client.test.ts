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
import type {
  ChatRecordHeadStamp,
  ChatRecordSummary,
  ChatRecordSummaryStreamV13,
} from "@traycer/protocol/host/epic/chat-records";
import type { TuiAgentRecordSummary } from "@traycer/protocol/host/epic/tui-agent-records";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamCloseReason,
  StreamConnectionStatus,
} from "../i-stream-session";
import {
  CHAT_RECORDS_STREAM_PARSED_MINOR_CEILING,
  ChatRecordsStreamClient,
  type ChatRecordsStreamDelta,
} from "../chat-records-stream-client";
import { WsStreamClient } from "../ws-stream-client";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";

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
    this.statusChangeHandler(status, reason, null);
  }
}

function makeWsStreamClient(
  session: IStreamSession,
): WsStreamClient<typeof hostStreamRpcRegistry> {
  const client = new WsStreamClient({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: hostStreamRpcRegistry,
    endpoint: () => null,
    hostId: null,
    bearer: () => null,
    auth: null,
    clock: null,
    hostCredentialMint: null,
    onHostCredentialState: null,
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

/**
 * The `@1.3` STREAM row - `row()` above plus the optional/nullable `head`.
 *
 * Deliberately not the list's `@1.2` row: the stream never carries
 * `docResident`, because a delta cannot state a chat's home.
 */
function rowStreamV13(
  overrides: Partial<ChatRecordSummaryStreamV13>,
): ChatRecordSummaryStreamV13 {
  return { ...row(overrides), ...overrides };
}

function headStamp(
  overrides: Partial<ChatRecordHeadStamp>,
): ChatRecordHeadStamp {
  return {
    headSha256: "a".repeat(64),
    throughRecordSeq: 5,
    publishedAt: 1_000,
    ...overrides,
  };
}

function tuiRow(
  overrides: Partial<TuiAgentRecordSummary>,
): TuiAgentRecordSummary {
  return {
    tuiAgentId: "tui-1",
    ownerUserId: "user-a",
    hostId: "host-1",
    harnessId: "claude",
    harnessSessionId: "sess-1",
    parentId: null,
    title: "A terminal agent",
    isTitleEditedByUser: false,
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    archivedAt: null,
    workspaceFolders: ["/repo"],
    workspaceMode: null,
    model: "opus",
    reasoningEffort: null,
    agentMode: "regular",
    profileId: null,
    terminalAgentArgs: null,
    terminalShellCommand: null,
    terminalShellArgs: null,
    revision: 3,
    ...overrides,
  };
}

interface StatusCall {
  readonly status: StreamConnectionStatus;
  readonly reason: StreamCloseReason | null;
}

interface Harness {
  readonly session: StubSession;
  readonly deltas: ChatRecordsStreamDelta[];
  readonly client: ChatRecordsStreamClient;
  readonly statuses: StatusCall[];
  readonly wsStreamClient: WsStreamClient<typeof hostStreamRpcRegistry>;
}

function harness(): Harness {
  const session = new StubSession();
  const wsStreamClient = makeWsStreamClient(session);
  const deltas: ChatRecordsStreamDelta[] = [];
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

  it("delivers the @1.1 terminal-agent kinds as typed deltas, each naming its epic", () => {
    const h = harness();
    const record = tuiRow({ tuiAgentId: "tui-a", revision: 9 });
    h.session.emitFrame({
      kind: "tuiUpsert",
      hasBinaryPayload: false,
      epicId: "epic-1",
      tuiAgentId: "tui-a",
      revision: 9,
      record,
    });
    h.session.emitFrame({
      kind: "tuiRemove",
      hasBinaryPayload: false,
      epicId: "epic-2",
      tuiAgentId: "tui-b",
      reason: "deleted",
    });

    // The `@1.1` row is PROMOTED to the current union on the way through, and
    // both fills are exact rather than defaults: a `@1.1` host is never sent
    // the `@1.2` cloud arm (the host gates its emission on the negotiated
    // version), and the delta plane has no doc-resident producer at all - such
    // a row reaches a client through `epic.listTuiAgents` alone.
    expect(h.deltas).toEqual([
      {
        kind: "tuiUpsert",
        epicId: "epic-1",
        record: { ...record, docResident: false, origin: "registry" },
      },
      {
        kind: "tuiRemove",
        epicId: "epic-2",
        tuiAgentId: "tui-b",
        reason: "deleted",
      },
    ]);
    h.client.close();
  });

  it("TRIPWIRE: still delivers a tuiUpsert when the session negotiated @1.1", () => {
    // THE REGRESSION THIS PINS. A newer app talking to a host that only
    // negotiates `@1.1` parsed every frame with the `@1.2` schema - whose
    // `tuiUpsert` row is a union DISCRIMINATED on `origin`, a key the frozen
    // `@1.1` row does not have. So the upsert failed to parse and was dropped
    // while `tuiRemove`, unchanged between the minors, kept arriving: rows
    // vanished on removal and never came back on creation.
    const h = harness();
    h.session.negotiatedSchemaVersion = { major: 1, minor: 1 };
    const record = tuiRow({ tuiAgentId: "tui-legacy", revision: 4 });
    h.session.emitFrame({
      kind: "tuiUpsert",
      hasBinaryPayload: false,
      epicId: "epic-1",
      tuiAgentId: "tui-legacy",
      revision: 4,
      record,
    });

    expect(h.deltas).toEqual([
      {
        kind: "tuiUpsert",
        epicId: "epic-1",
        record: { ...record, docResident: false, origin: "registry" },
      },
    ]);
    h.client.close();
  });

  it("delivers the @1.2 cloud arm verbatim when the session negotiated @1.2", () => {
    // The other side of the branch: at `@1.2` the row is already the union, so
    // it passes through untouched - including the narrow cloud arm, which the
    // `@1.1` schema would reject.
    const h = harness();
    h.session.negotiatedSchemaVersion = { major: 1, minor: 2 };
    const record = {
      origin: "cloud" as const,
      tuiAgentId: "tui-remote",
      ownerUserId: "user-a",
      hostId: "host-elsewhere",
      harnessId: "claude",
      parentId: null,
      title: "An agent on my other machine",
      isTitleEditedByUser: false,
      createdAt: 1,
      updatedAt: 2,
      archived: false,
      revision: 7,
    };
    h.session.emitFrame({
      kind: "tuiUpsert",
      hasBinaryPayload: false,
      epicId: "epic-1",
      tuiAgentId: "tui-remote",
      revision: 7,
      record,
    });

    expect(h.deltas).toEqual([{ kind: "tuiUpsert", epicId: "epic-1", record }]);
    h.client.close();
  });

  it("drops a tuiUpsert whose envelope disagrees with the row it carries", () => {
    // The contract's envelope invariant, exercised through this client: a
    // frame addressing one agent while carrying another's row (or ordering by
    // a revision the row does not hold) is refused outright, not guessed at.
    const h = harness();
    h.session.emitFrame({
      kind: "tuiUpsert",
      hasBinaryPayload: false,
      epicId: "epic-1",
      tuiAgentId: "tui-OTHER",
      revision: 9,
      record: tuiRow({ tuiAgentId: "tui-a", revision: 9 }),
    });
    h.session.emitFrame({
      kind: "tuiUpsert",
      hasBinaryPayload: false,
      epicId: "epic-1",
      tuiAgentId: "tui-a",
      revision: 1,
      record: tuiRow({ tuiAgentId: "tui-a", revision: 9 }),
    });
    expect(h.deltas).toEqual([]);
    h.client.close();
  });

  it("drops a malformed terminal-agent frame instead of guessing at it", () => {
    const h = harness();
    // A removal reason from a later, widened minor.
    h.session.emitFrame({
      kind: "tuiRemove",
      hasBinaryPayload: false,
      epicId: "epic-1",
      tuiAgentId: "tui-a",
      reason: "quarantined",
    });
    // An upsert with no row.
    h.session.emitFrame({
      kind: "tuiUpsert",
      hasBinaryPayload: false,
      epicId: "epic-1",
      tuiAgentId: "tui-a",
      revision: 1,
    });
    expect(h.deltas).toEqual([]);
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

  describe("the @1.3 chat `head` - parsed by the NEGOTIATED minor, not the newest schema", () => {
    it("delivers the row's `head` verbatim when the session negotiated @1.3", () => {
      const h = harness();
      h.session.negotiatedSchemaVersion = { major: 1, minor: 3 };
      const head = headStamp({ publishedAt: 42 });
      const record = rowStreamV13({ chatId: "chat-a", revision: 7, head });
      h.session.emitFrame({
        kind: "upsert",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-a",
        revision: 7,
        record,
      });

      expect(h.deltas).toEqual([{ kind: "upsert", epicId: "epic-1", record }]);
      const delta = h.deltas[0];
      if (delta.kind !== "upsert") throw new Error("expected upsert");
      expect(delta.record.head).toEqual(head);
      h.client.close();
    });

    it("STRIPS `head` at @1.2 - the older schema is a plain object that discards the added key", () => {
      const h = harness();
      h.session.negotiatedSchemaVersion = { major: 1, minor: 2 };
      const record = rowStreamV13({
        chatId: "chat-a",
        revision: 7,
        head: headStamp({}),
      });
      h.session.emitFrame({
        kind: "upsert",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-a",
        revision: 7,
        record,
      });

      expect(h.deltas).toHaveLength(1);
      const delta = h.deltas[0];
      if (delta.kind !== "upsert") throw new Error("expected upsert");
      expect(delta.record).not.toHaveProperty("head");
      h.client.close();
    });

    it("STRIPS `head` when the handshake has not settled (negotiated === null) - the conservative @1.1 parse", () => {
      const h = harness();
      // `negotiatedSchemaVersion` starts `null` in the harness; asserted here
      // rather than relied upon, since the whole point is this path.
      expect(h.session.negotiatedSchemaVersion).toBeNull();
      const record = rowStreamV13({
        chatId: "chat-a",
        revision: 7,
        head: headStamp({}),
      });
      h.session.emitFrame({
        kind: "upsert",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-a",
        revision: 7,
        record,
      });

      expect(h.deltas).toHaveLength(1);
      const delta = h.deltas[0];
      if (delta.kind !== "upsert") throw new Error("expected upsert");
      expect(delta.record).not.toHaveProperty("head");
      h.client.close();
    });

    it("passes `head: null` through at @1.3 - the host's positive 'no publication' statement", () => {
      const h = harness();
      h.session.negotiatedSchemaVersion = { major: 1, minor: 3 };
      const record = rowStreamV13({
        chatId: "chat-a",
        revision: 7,
        head: null,
      });
      h.session.emitFrame({
        kind: "upsert",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-a",
        revision: 7,
        record,
      });

      expect(h.deltas).toEqual([{ kind: "upsert", epicId: "epic-1", record }]);
      const delta = h.deltas[0];
      if (delta.kind !== "upsert") throw new Error("expected upsert");
      expect(delta.record.head).toBeNull();
      h.client.close();
    });

    it("drops a frame at @1.3 whose `head` is malformed, instead of guessing at it", () => {
      const h = harness();
      h.session.negotiatedSchemaVersion = { major: 1, minor: 3 };
      const record = rowStreamV13({
        chatId: "chat-a",
        revision: 7,
        // Uppercase digest - the sha256 hex schema is `[0-9a-f]{64}`, closed.
        head: headStamp({ headSha256: "A".repeat(64) }),
      });
      h.session.emitFrame({
        kind: "upsert",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-a",
        revision: 7,
        record,
      });

      expect(h.deltas).toEqual([]);
      h.client.close();
    });
  });

  /**
   * `@1.4` is registered in the protocol, so this client ADVERTISES it and a
   * `@1.4` host negotiates it. The ladder used to read `minor >= 3`, which
   * parsed those frames with the `@1.3` schema - a plain object that silently
   * dropped both of the things the minor exists to carry. These pin the fix:
   * one arm per minor, a drop for a minor with no arm, and the ceiling pinned
   * to the registry so the NEXT minor cannot repeat it.
   */
  describe("the @1.4 stamped frames - one arm per minor, nothing absorbed", () => {
    const listRevision = { epoch: "epoch-1", revision: 12 };

    it("PARSES a @1.4 tuiUpsert's session facet instead of stripping it at the wire (the delta's own type still stops at @1.2)", () => {
      const h = harness();
      h.session.negotiatedSchemaVersion = { major: 1, minor: 4 };
      const record = {
        ...tuiRow({ tuiAgentId: "tui-a", revision: 9 }),
        docResident: false,
        origin: "registry" as const,
        sessionState: "sleeping" as const,
        lastExit: "reaped" as const,
      };
      h.session.emitFrame({
        kind: "tuiUpsert",
        hasBinaryPayload: false,
        epicId: "epic-1",
        tuiAgentId: "tui-a",
        revision: 9,
        listRevision,
        record,
      });

      expect(h.deltas).toHaveLength(1);
      const delta = h.deltas[0];
      if (delta.kind !== "tuiUpsert") throw new Error("expected tuiUpsert");
      // ONE LAYER, named in the title because the finding this sits under is
      // framed as "silently discarded" and a reader scanning names would
      // otherwise take this for end-to-end. It is not: `TuiAgentRecordDelta`
      // types the row down to `@1.2`, and `tui-agent-record-table.ts`'s
      // `applyDelta` still overwrites the facet with the held one, which is
      // stage 2's to change. What this pins is the half that was a WIRE defect
      // - the `@1.3` schema stripping the keys off a `@1.4` frame, before any
      // consumer could have had them - so the assertion reads the parsed
      // object rather than a typed field.
      expect(delta.record).toMatchObject({
        sessionState: "sleeping",
        lastExit: "reaped",
      });
      h.client.close();
    });

    it("validates listRevision rather than discarding it - a malformed one drops the frame", () => {
      const h = harness();
      h.session.negotiatedSchemaVersion = { major: 1, minor: 4 };
      h.session.emitFrame({
        kind: "upsert",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-a",
        revision: 7,
        // `recordListEpochSchema` is `min(1)`: an empty epoch is
        // unrepresentable, because two of them would compare equal and license
        // the stale `unchanged` the field exists to prevent. Parsed with the
        // `@1.3` schema this key is not merely accepted - it is STRIPPED, and
        // the frame is delivered as though the host had never stamped it.
        listRevision: { epoch: "", revision: 7 },
        record: rowStreamV13({ chatId: "chat-a", revision: 7 }),
      });

      expect(h.deltas).toEqual([]);
      h.client.close();
    });

    it("drops a minor above this build's ceiling instead of parsing it with the newest arm", () => {
      const h = harness();
      h.session.negotiatedSchemaVersion = {
        major: 1,
        minor: CHAT_RECORDS_STREAM_PARSED_MINOR_CEILING + 1,
      };
      h.session.emitFrame({
        kind: "upsert",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-a",
        revision: 7,
        listRevision,
        record: rowStreamV13({ chatId: "chat-a", revision: 7 }),
      });

      // Dropped, and the poll carries the table meanwhile - this class's
      // declared degrade. The alternative is what `minor >= 3` did: succeed
      // with the unknown minor's fields stripped, which has no symptom at all.
      expect(h.deltas).toEqual([]);
      h.client.close();
    });

    it("parses every minor the registry installs - the ceiling is not allowed to lag", () => {
      // THE LOUD ARM. Registering a minor is an edit in the protocol package;
      // negotiation derives `min(mine, theirs)` from the registry and never
      // consults this client. Without this assertion a new minor is negotiated,
      // parsed by the arm below it, and silently stripped - which is exactly
      // how `@1.4` shipped ahead of its arm.
      expect(CHAT_RECORDS_STREAM_PARSED_MINOR_CEILING).toBe(
        hostStreamRpcRegistry["host.chatRecords.subscribe"][1].latestMinor,
      );
    });
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
