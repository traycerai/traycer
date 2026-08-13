import {
  hostChatRecordsSubscribeServerFrameSchemaV10,
  type ChatRecordRemovalReason,
  type ChatRecordSummary,
} from "@traycer/protocol/host/epic/chat-records";
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

export interface ChatRecordsStreamCallbacks {
  /**
   * A record delta, already parsed and narrowed. Frames name their epic
   * (the subscription is HOST-scoped, covering every epic that host has open
   * plus its own-row changes), so per-epic routing is the consumer's.
   */
  readonly onDelta: (delta: ChatRecordDelta) => void;
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
    const parsed =
      hostChatRecordsSubscribeServerFrameSchemaV10.safeParse(envelope);
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
      case "pong": {
        // The transport owns the heartbeat: it sends the `ping` client frame
        // on its own interval and does the pong bookkeeping before this
        // handler ever runs.
        return;
      }
    }
  }
}
