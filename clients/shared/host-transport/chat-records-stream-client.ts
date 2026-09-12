import {
  hostChatRecordsSubscribeServerFrameSchemaV11,
  hostChatRecordsSubscribeServerFrameSchemaV12,
  hostChatRecordsSubscribeServerFrameSchemaV13,
  hostChatRecordsSubscribeServerFrameSchemaV14,
  type ChatRecordRemovalReason,
  type ChatRecordSummaryStreamV13,
  type HostChatRecordsSubscribeServerFrameV13,
} from "@traycer/protocol/host/epic/chat-records";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { TuiAgentRecordSummaryV12 } from "@traycer/protocol/host/epic/tui-agent-records";
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
export type TuiAgentRecordDelta =
  | {
      readonly kind: "tuiUpsert";
      readonly epicId: string;
      /**
       * The row, complete. Same envelope invariant as the chat upsert: the
       * frame repeats `tuiAgentId`/`revision` and the contract refuses a frame
       * where they disagree, so only the row's own copy travels here.
       */
      readonly record: TuiAgentRecordSummaryV12;
    }
  | {
      readonly kind: "tuiRemove";
      readonly epicId: string;
      readonly tuiAgentId: string;
      readonly reason: ChatRecordRemovalReason;
    };

/**
 * Everything `host.chatRecords.subscribe` can deliver AS THIS CLIENT NAMES IT.
 * An older host negotiates down and simply never sends what its minor did not
 * have: @1.0 omits the terminal-agent kinds entirely, @1.1 sends them for its
 * OWN rows only and never for a cross-host replica, and @1.0-@1.2 carry no
 * `head` on the chat `upsert` row.
 *
 * A `@1.4` host sends two things more - `listRevision` on every record frame
 * and the session facet on `tuiUpsert`'s row - and they are parsed (see
 * {@link ParsedFrame}) but not yet named here. Stage 2 names them; until then
 * they are carried as unnamed data rather than stripped at the wire.
 */
export type ChatRecordsStreamDelta = ChatRecordDelta | TuiAgentRecordDelta;

export interface ChatRecordsStreamCallbacks {
  /**
   * A record delta, already parsed and narrowed. Frames name their epic
   * (the subscription is HOST-scoped, covering every epic that host has open
   * plus its own-row changes), so per-epic routing is the consumer's.
   */
  readonly onDelta: (delta: ChatRecordsStreamDelta) => void;
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
 * The `@1.3` frame is what every arm resolves to, `@1.4` included, and the
 * direction is what makes that safe: `@1.4` only ADDS (`listRevision` on the
 * four record kinds, the session facet on `tuiUpsert`'s row), so a `@1.4` frame
 * is a `@1.3` frame with more on it and the extra travels as data this file's
 * consumers do not yet name.
 *
 * That is a TYPE ceiling, not a parse one, and the difference is the whole of
 * F2: each minor is parsed by its own schema, so nothing is stripped off the
 * wire, and the added fields reach whatever names them next. Consuming
 * `listRevision` is stage 2's (it is what advances a client's list stamp from a
 * delta), and the session facet rides that same plumbing - see
 * `tui-agent-record-table.ts`'s `applyDelta`, which carries the facet forward
 * from the held row meanwhile.
 */
type ParsedFrame =
  | {
      readonly success: true;
      readonly data: HostChatRecordsSubscribeServerFrameV13;
    }
  | { readonly success: false };

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

/**
 * The newest `host.chatRecords.subscribe` minor this client has a parse arm
 * for.
 *
 * Exported for ONE purpose: the test pins it against
 * `hostStreamRpcRegistry["host.chatRecords.subscribe"][1].latestMinor`, so
 * registering a minor without adding an arm here fails loudly. That pin is the
 * only thing that can catch it. Registering a minor is an edit in another
 * package, `prepareStreamSubscribeRequest` declares `min(mine, theirs)` off the
 * registry with no reference to this file, and a `>=` ladder answers for
 * every minor above its top arm without anybody choosing that - which is
 * exactly how `@1.4` came to be negotiated and then parsed as `@1.3`, silently
 * discarding the list revision and the session facet the minor exists to carry.
 */
export const CHAT_RECORDS_STREAM_PARSED_MINOR_CEILING = 4;

function parseNegotiatedFrame(
  negotiated: SchemaVersion | null,
  envelope: StreamFrameEnvelope,
): ParsedFrame {
  if (negotiated === null || negotiated.major !== 1) {
    return parseV11Frame(envelope);
  }
  // A minor with no arm of its own. DROPPED rather than parsed with the newest
  // arm this build has: every schema here is a plain (non-strict) object, so a
  // newer frame parsed with an older arm SUCCEEDS with the new minor's fields
  // stripped - the failure mode that has no symptom. A drop has one (the poll
  // carries the table meanwhile, per this class's degrade contract) and the pin
  // on the constant above means a build whose protocol and client moved
  // together never reaches it.
  if (negotiated.minor > CHAT_RECORDS_STREAM_PARSED_MINOR_CEILING) {
    return { success: false };
  }
  // EXACT minors below, never `>=`. `>=` is what let the top arm answer for a
  // minor it was never written for; the guard above is only a backstop, and it
  // cannot help while the ladder itself still claims everything above it.
  if (negotiated.minor === 4) {
    return hostChatRecordsSubscribeServerFrameSchemaV14.safeParse(envelope);
  }
  if (negotiated.minor === 3) {
    return hostChatRecordsSubscribeServerFrameSchemaV13.safeParse(envelope);
  }
  if (negotiated.minor === 2) {
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
    // "Always" is now enforced by the ladder's shape rather than asserted by
    // this comment. It used to read `minor >= 3`, which is the same silent
    // strip one minor along: `@1.4` is registered, so this client advertises it
    // and a `@1.4` host negotiates it, and the `@1.3` schema would have dropped
    // `listRevision` and the session facet off every delta with nothing failing
    // anywhere. Each minor now has its own arm, and
    // `CHAT_RECORDS_STREAM_PARSED_MINOR_CEILING` is pinned against the
    // registry so the NEXT minor cannot repeat it.
    const negotiated = this.session.getNegotiatedSchemaVersion();
    const parsed = parseNegotiatedFrame(negotiated, envelope);
    // A frame this build cannot parse is dropped rather than guessed at. The
    // removal-reason enum is CLOSED for exactly this reason: a widened reason
    // arrives as an unparseable frame, and the poll - which still sees the row
    // leave the host's list - is what keeps the table correct meanwhile.
    if (!parsed.success) return;
    const frame = parsed.data;
    switch (frame.kind) {
      case "upsert": {
        this.callbacks.onDelta({
          kind: "upsert",
          epicId: frame.epicId,
          record: frame.record,
        });
        return;
      }
      case "remove": {
        this.callbacks.onDelta({
          kind: "remove",
          epicId: frame.epicId,
          chatId: frame.chatId,
          reason: frame.reason,
        });
        return;
      }
      case "tuiUpsert": {
        this.callbacks.onDelta({
          kind: "tuiUpsert",
          epicId: frame.epicId,
          record: frame.record,
        });
        return;
      }
      case "tuiRemove": {
        this.callbacks.onDelta({
          kind: "tuiRemove",
          epicId: frame.epicId,
          tuiAgentId: frame.tuiAgentId,
          reason: frame.reason,
        });
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
