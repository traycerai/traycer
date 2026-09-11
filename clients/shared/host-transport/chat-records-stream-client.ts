import {
  hostChatRecordsSubscribeServerFrameSchemaV11,
  hostChatRecordsSubscribeServerFrameSchemaV12,
  hostChatRecordsSubscribeServerFrameSchemaV13,
  hostChatRecordsSubscribeServerFrameSchemaV14,
  type ChatRecordRemovalReason,
  type ChatRecordSummaryStreamV13,
  type HostChatRecordsSubscribeServerFrameV13,
  type HostChatRecordsSubscribeServerFrameV14,
} from "@traycer/protocol/host/epic/chat-records";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type {
  AgentSessionLastExit,
  AgentSessionState,
} from "@traycer/protocol/host/agent-session-state";
import type { RecordListRevision } from "@traycer/protocol/host/epic/record-list-revision";
import type {
  TuiAgentRecordSummaryV12,
  TuiAgentRecordSummaryV13,
} from "@traycer/protocol/host/epic/tui-agent-records";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { IHostStreamClient } from "./host-stream-client";

/**
 * One chat-record delta, in the two-op grammar the cloud feed, the host's
 * inbox and this stream all speak (`upsert` / `remove`).
 *
 * Modelled as a discriminated union rather than two callbacks with positional
 * arguments because the consumer's own reducer is a switch on exactly this
 * discriminant - the store applies it, the tests build it, and a shape both
 * sides agree on by type is one fewer seam where a chatId and an epicId can be
 * passed in the wrong order.
 */
export type ChatRecordDelta =
  | {
      readonly kind: "upsert";
      readonly epicId: string;
      /**
       * The row, complete. Its own `revision` is the METADATA ordering fact -
       * the frame envelope repeats it, and the contract's invariant is that
       * the two are equal, so carrying only one of them here removes the
       * possibility of a consumer guarding on the copy the host did not mean.
       *
       * The `@1.3` STREAM row, so a `@1.3` session's `head` (the chat's cloud
       * publication stamp, ordered by its own `publishedAt`) reaches the
       * consumer. On an older negotiated minor the key is simply absent - the
       * host never sent it and the older schema would strip it anyway - which
       * consumers collapse with `head ?? null`.
       *
       * NOT the list's `@1.2` row: that one also carries `docResident`, which
       * a delta may not state (see `chatRecordSummaryStreamV13Schema`). The
       * consumer seeds that field from what it already holds.
       */
      readonly record: ChatRecordSummaryStreamV13;
    }
  | {
      readonly kind: "remove";
      readonly epicId: string;
      readonly chatId: string;
      readonly reason: ChatRecordRemovalReason;
    };

/**
 * One terminal-agent record delta, the `@1.1` addition riding the same
 * host-scoped stream (`tuiUpsert` / `tuiRemove`), carrying the `@1.2` row.
 *
 * A SEPARATE union rather than two more members on {@link ChatRecordDelta},
 * because the two grammars address different record tables: the consumer's
 * chat reducer switches on `upsert`/`remove` and its terminal-agent reducer on
 * these two, and a single union would force every reducer to carry dead
 * branches for the other kind. The stream callback speaks the sum of both
 * ({@link ChatRecordsStreamDelta}); routing them apart is the mount's job.
 */
/**
 * The session facet a `@1.4` `tuiUpsert` row carries: whether the agent's
 * session is alive, asleep or over, and why the last one ended.
 *
 * Lifted OFF the row into its own member rather than widening
 * {@link TuiAgentRecordDelta}'s `record` to the `@1.3` row, because the delta
 * needs a third answer the row has no way to give. The row's two fields are
 * nullable and `null` there means "the serving host cannot know" - a peer-host
 * row, a replica, a row written before the facet existed. A frame from a
 * `@1.3` host says something different and incompatible: not "unknown" but
 * NOT STATED, this minor has no field for it. Collapsing the two would blank a
 * sleeping agent's badge on every unrelated rename until the next snapshot,
 * which is exactly the carry-forward `tui-agent-record-table.ts` exists to do.
 * `null` HERE is "not stated"; a non-null facet's own fields carry "unknown".
 */
export interface TuiAgentSessionFacet {
  readonly sessionState: AgentSessionState | null;
  readonly lastExit: AgentSessionLastExit | null;
}

export type TuiAgentRecordDelta =
  | {
      readonly kind: "tuiUpsert";
      readonly epicId: string;
      /**
       * The row, complete. Same envelope invariant as the chat upsert: the
       * frame repeats `tuiAgentId`/`revision` and the contract refuses a frame
       * where they disagree, so only the row's own copy travels here.
       *
       * Typed at the `@1.2` row even when a `@1.4` frame carried the `@1.3`
       * one: the facet travels beside it as {@link sessionFacet}, which is the
       * only place the "not stated" answer can be represented.
       */
      readonly record: TuiAgentRecordSummaryV12;
      /**
       * What the frame said about the session, or `null` when the negotiated
       * minor had nowhere to say it - see {@link TuiAgentSessionFacet}.
       */
      readonly sessionFacet: TuiAgentSessionFacet | null;
    }
  | {
      readonly kind: "tuiRemove";
      readonly epicId: string;
      readonly tuiAgentId: string;
      readonly reason: ChatRecordRemovalReason;
    };

/**
 * Everything `host.chatRecords.subscribe@1.4` can deliver. An older host
 * negotiates down and simply never sends what its minor did not have: @1.0
 * omits the terminal-agent kinds entirely, @1.1 sends them for its OWN rows
 * only and never for a cross-host replica, @1.0-@1.2 carry no `head` on
 * the chat `upsert` row, and @1.0-@1.3 carry neither the list revision nor
 * the session facet.
 */
export type ChatRecordsStreamDelta = ChatRecordDelta | TuiAgentRecordDelta;

export interface ChatRecordsStreamCallbacks {
  /**
   * A record delta, already parsed and narrowed. Frames name their epic
   * (the subscription is HOST-scoped, covering every epic that host has open
   * plus its own-row changes), so per-epic routing is the consumer's.
   *
   * `listRevision` is the `@1.4` LIST stamp the write that produced this delta
   * left behind, or `null` from an older host that never stamped one. A second
   * argument rather than a member of the delta, because it is a fact about the
   * ENVELOPE and not about the record: the delta is what the record tables
   * apply (across the runtime worker's command bridge, in the GUI's case) and
   * the stamp is what the polling client compares its own held revision
   * against. Folding it into the union would ship it to a consumer that has no
   * use for it and invite a reducer to treat a list-level counter as a row
   * fact - the same confusion `recordListRevisionSchema`'s own note warns
   * about.
   */
  readonly onDelta: (
    delta: ChatRecordsStreamDelta,
    listRevision: RecordListRevision | null,
  ) => void;
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

export interface ChatRecordsStreamClientOptions {
  // `IHostStreamClient`, not the concrete `WsStreamClient`: this client only
  // calls `.subscribe()`, and every sibling stream client here takes the
  // interface so a remote host can supply its own transport.
  readonly wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>;
  readonly callbacks: ChatRecordsStreamCallbacks;
}

/**
 * Typed client for `host.chatRecords.subscribe@1.0` - the record-change PUSH
 * stream that makes `epic.listChatRecords` fresh instead of merely eventual.
 *
 * ## What this owns, and what it deliberately does not
 *
 * It owns exactly one thing: turning wire envelopes into typed deltas. The
 * reconnect loop, its backoff, the ping/pong heartbeat and the per-method
 * version negotiation all live in the session `WsStreamClient.subscribe(...)`
 * hands back - the same arrangement `AgentActivityStreamClient` and
 * `WorktreeChangedStreamClient` have, and the reason none of them re-implements
 * a redial. The session re-declares this method on every reconnect, so a
 * consumer never re-subscribes by hand.
 *
 * ## Degrade is the CALLER's decision, not this class's
 *
 * A host that predates the method never advertises it and the client-wide
 * support flag resolves to `"unsupported"`. This class does not inspect that:
 * the honest place to gate is the mount, which simply does not construct the
 * client (`useStreamMethodSupport(...) === "unsupported"`), leaving the 20s
 * `epic.listChatRecords` poll as the record table's only refresh. That is the
 * whole degrade contract - latency, never missing rows - and folding it in here
 * would mean this object had a silent do-nothing mode that looked identical to
 * a healthy one.
 *
 * ## No resume, by contract
 *
 * The stream carries deltas only; `epic.listChatRecords` IS the snapshot and
 * the consumer already polls it. So a reconnect means "re-read the list, then
 * apply what arrives", and a delta missed while disconnected converges on the
 * next poll rather than on a replay no host retains a log to serve.
 */
/**
 * An `@1.1` frame in the shape the `@1.3` consumer below reads.
 *
 * Only `tuiUpsert` needs anything: its row is the frozen registry shape, and
 * the current row is a union tagged by `origin`. The fill is EXACT rather than
 * a default, on two facts about what a `@1.1` host can emit:
 *
 *  - `origin: "registry"` - the cloud arm is `@1.2`, and the host gates its
 *    emission on the negotiated version, so a `@1.1` session is never sent one.
 *  - `docResident: false` - the delta plane has only ever had two producers,
 *    the registry (via the outbox) and the record inbox. A doc-resident row has
 *    no registry row to emit from and reaches a client through
 *    `epic.listTuiAgents` alone, never through this stream.
 *
 * Every other frame kind is byte-identical across the minors and passes
 * through untouched. The chat `upsert` row's `@1.3` `head` is an OPTIONAL key,
 * so a `@1.1`/`@1.2` row is already a valid `@1.3` row with the key absent -
 * no fill is needed there, and none would be honest (an older host never said
 * whether the chat has a publication).
 */
/**
 * A frame in whichever frozen shape its minor promised.
 *
 * The two sets are read through ONE switch rather than normalized onto one of
 * them, because neither direction is honest: promoting a `@1.3` frame to `@1.4`
 * would have to invent a `listRevision` (and the whole point of that stamp is
 * that a client trusts `held + 1`), and demoting a `@1.4` one would drop the
 * two facts this minor exists to carry. What the two sets DO share is every
 * field the routing below reads, so the switch narrows across both and the two
 * additions are read by the accessors underneath it.
 */
type ChatRecordsStreamFrame =
  | HostChatRecordsSubscribeServerFrameV13
  | HostChatRecordsSubscribeServerFrameV14;

type ParsedFrame =
  | {
      readonly success: true;
      readonly data: ChatRecordsStreamFrame;
    }
  | { readonly success: false };

/**
 * The list stamp a record frame carries, or `null` on a minor that has none.
 *
 * `in` rather than a negotiated-version argument: the schema that parsed the
 * envelope is what decided whether the field survived, so asking the parsed
 * value keeps the two from being able to disagree. `pong` has no stamp on
 * either minor - it is a liveness frame, and stamping it would invite a
 * consumer to read a keepalive as progress.
 */
function listRevisionOf(
  frame: ChatRecordsStreamFrame,
): RecordListRevision | null {
  return "listRevision" in frame ? frame.listRevision : null;
}

/**
 * The session facet a `tuiUpsert` row carries, or `null` when the row's minor
 * had no field for it - see {@link TuiAgentSessionFacet} for why those two are
 * not the same answer.
 */
function sessionFacetOf(
  record: TuiAgentRecordSummaryV12 | TuiAgentRecordSummaryV13,
): TuiAgentSessionFacet | null {
  if (!("sessionState" in record)) return null;
  return { sessionState: record.sessionState, lastExit: record.lastExit };
}

function parseV11Frame(envelope: StreamFrameEnvelope): ParsedFrame {
  const parsed =
    hostChatRecordsSubscribeServerFrameSchemaV11.safeParse(envelope);
  if (!parsed.success) return { success: false };
  const frame = parsed.data;
  if (frame.kind !== "tuiUpsert") return { success: true, data: frame };
  return {
    success: true,
    data: {
      ...frame,
      record: { ...frame.record, docResident: false, origin: "registry" },
    },
  };
}

function parseNegotiatedFrame(
  negotiated: SchemaVersion | null,
  envelope: StreamFrameEnvelope,
): ParsedFrame {
  if (negotiated === null || negotiated.major !== 1) {
    return parseV11Frame(envelope);
  }
  if (negotiated.minor >= 4) {
    return hostChatRecordsSubscribeServerFrameSchemaV14.safeParse(envelope);
  }
  if (negotiated.minor >= 3) {
    return hostChatRecordsSubscribeServerFrameSchemaV13.safeParse(envelope);
  }
  if (negotiated.minor >= 2) {
    return hostChatRecordsSubscribeServerFrameSchemaV12.safeParse(envelope);
  }
  return parseV11Frame(envelope);
}

export class ChatRecordsStreamClient {
  private readonly session: IStreamSession;
  private readonly callbacks: ChatRecordsStreamCallbacks;
  private closed = false;

  constructor(options: ChatRecordsStreamClientOptions) {
    this.callbacks = options.callbacks;
    this.session = options.wsStreamClient.subscribe(
      "host.chatRecords.subscribe",
      {},
    );
    this.session.onServerFrame((envelope) => {
      this.handleServerFrame(envelope);
    });
    this.session.onStatusChange((status, reason) => {
      this.callbacks.onConnectionStatus(status, reason);
    });
  }

  /** Tears down the underlying session. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.session.close();
  }

  private handleServerFrame(envelope: StreamFrameEnvelope): void {
    // Parsed against THE NEGOTIATED MINOR, not against the newest schema.
    //
    // The tempting shortcut - "each minor accepts the previous one's frames, so
    // the latest schema serves them all" - is true of every frame here EXCEPT
    // `tuiUpsert`, and that exception shipped as a regression. `@1.1` froze its
    // row at the original shape, which has no `origin`; `@1.2` replaced it with
    // a union DISCRIMINATED on `origin`. So a verbatim `@1.1` upsert cannot
    // parse against `@1.2`, and a current app talking to a host that only
    // negotiates `@1.1` silently dropped every terminal-agent upsert it was
    // sent. Asymmetrically, too: `tuiRemove` is unchanged and kept arriving, so
    // rows vanished on removal and never came back on creation.
    //
    // `null` means the handshake has not settled. Parsing with the OLDER schema
    // then is the conservative choice: an `@1.1` frame is accepted and
    // promoted, and a `@1.2` cloud frame is dropped until the version is known
    // rather than being admitted under a shape nobody has agreed on.
    //
    // `@1.3` grows the chat `upsert` row by the cloud publication `head`. The
    // `@1.2` schema is a plain (non-strict) object and STRIPS that key, so
    // parsing a `@1.3` session's frames with it would silently discard the
    // very fact the minor exists to carry - the published-copy tile would
    // never learn a new turn was published. Same rule as the `tuiUpsert`
    // regression above: the negotiated minor picks the schema, always.
    //
    // `@1.4` grows every RECORD frame by the list revision the write left
    // behind, and the `tuiUpsert` row by the session facet. Parsing a `@1.4`
    // session's frames with the `@1.3` schema would strip both - the polling
    // client would then read every delta as carrying no stamp, never advance
    // its held revision, and ship a full snapshot per change per open tab,
    // which is the entire cost this minor removes.
    const negotiated = this.session.getNegotiatedSchemaVersion();
    const parsed = parseNegotiatedFrame(negotiated, envelope);
    // A frame this build cannot parse is dropped rather than guessed at. The
    // removal-reason enum is CLOSED for exactly this reason: a widened reason
    // arrives as an unparseable frame, and the poll - which still sees the row
    // leave the host's list - is what keeps the table correct meanwhile.
    if (!parsed.success) return;
    const frame = parsed.data;
    const listRevision = listRevisionOf(frame);
    switch (frame.kind) {
      case "upsert": {
        this.callbacks.onDelta(
          {
            kind: "upsert",
            epicId: frame.epicId,
            record: frame.record,
          },
          listRevision,
        );
        return;
      }
      case "remove": {
        this.callbacks.onDelta(
          {
            kind: "remove",
            epicId: frame.epicId,
            chatId: frame.chatId,
            reason: frame.reason,
          },
          listRevision,
        );
        return;
      }
      case "tuiUpsert": {
        this.callbacks.onDelta(
          {
            kind: "tuiUpsert",
            epicId: frame.epicId,
            record: frame.record,
            sessionFacet: sessionFacetOf(frame.record),
          },
          listRevision,
        );
        return;
      }
      case "tuiRemove": {
        this.callbacks.onDelta(
          {
            kind: "tuiRemove",
            epicId: frame.epicId,
            tuiAgentId: frame.tuiAgentId,
            reason: frame.reason,
          },
          listRevision,
        );
        return;
      }
      case "pong": {
        // The transport owns the heartbeat: it sends the `ping` client frame
        // on its own interval and does the pong bookkeeping before this
        // handler ever runs.
        return;
      }
    }
  }
}
