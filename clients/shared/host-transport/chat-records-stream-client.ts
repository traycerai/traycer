import {
  hostChatRecordsSubscribeServerFrameSchemaV11,
  hostChatRecordsSubscribeServerFrameSchemaV12,
  type ChatRecordRemovalReason,
  type ChatRecordSummary,
  type HostChatRecordsSubscribeServerFrameV12,
} from "@traycer/protocol/host/epic/chat-records";
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
       * The row, complete. Its own `revision` is the ordering fact - the frame
       * envelope repeats it, and the contract's invariant is that the two are
       * equal, so carrying only one of them here removes the possibility of a
       * consumer guarding on the copy the host did not mean.
       */
      readonly record: ChatRecordSummary;
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
 * Everything `host.chatRecords.subscribe@1.2` can deliver. An older host
 * negotiates down and simply never sends what its minor did not have: @1.0
 * omits the terminal-agent kinds entirely, @1.1 sends them for its OWN rows
 * only and never for a cross-host replica.
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
 * An `@1.1` frame in the shape the `@1.2` consumer below reads.
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
 * Every other frame kind is byte-identical across the two minors and passes
 * through untouched.
 */
type ParsedFrame =
  | {
      readonly success: true;
      readonly data: HostChatRecordsSubscribeServerFrameV12;
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
    const negotiated = this.session.getNegotiatedSchemaVersion();
    const parsed =
      negotiated !== null && negotiated.major === 1 && negotiated.minor >= 2
        ? hostChatRecordsSubscribeServerFrameSchemaV12.safeParse(envelope)
        : parseV11Frame(envelope);
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
