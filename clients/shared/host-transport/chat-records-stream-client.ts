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

export type ChatRecordDelta =
  | {
      readonly kind: "upsert";
      readonly epicId: string;
      /** The row, complete. */
      readonly record: ChatRecordSummary;
    }
  | {
      readonly kind: "remove";
      readonly epicId: string;
      readonly chatId: string;
      readonly reason: ChatRecordRemovalReason;
    };

    /**
     * One terminal-agent record delta, the `@1.1` addition riding the same host-scoped stream (`tuiUpsert` / `tuiRemove`), carrying the `@1.2` row.
     */
export type TuiAgentRecordDelta =
  | {
      readonly kind: "tuiUpsert";
      readonly epicId: string;
      /**
       * The row, complete.
       * Same envelope invariant as the chat upsert: the frame repeats `tuiAgentId`/`revision` and the contract refuses a frame where they disagree, so only the row's own copy travels here.
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
     * Everything `host.chatRecords.subscribe@1.2` can deliver.
     * An older host negotiates down and simply never sends what its minor did not have: @1.0 omits the terminal-agent kinds entirely, @1.1 sends them for its own rows only and never for a cross-host replica.
     */
export type ChatRecordsStreamDelta = ChatRecordDelta | TuiAgentRecordDelta;

export interface ChatRecordsStreamCallbacks {
  /** A record delta, already parsed and narrowed. */
  readonly onDelta: (delta: ChatRecordsStreamDelta) => void;
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

export interface ChatRecordsStreamClientOptions {
  // `IHostStreamClient`, not the concrete `WsStreamClient`: this client only calls `.subscribe()`, and every sibling stream client here takes the interface so a remote host can supply its own transport.
  readonly wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>;
  readonly callbacks: ChatRecordsStreamCallbacks;
}

/** Typed client for `host.chatRecords.subscribe@1.0`. The session re-declares this method on every reconnect, so a consumer never re-subscribes by hand. */
/** An `@1.1` frame in the shape the `@1.2` consumer below reads. */
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
    // Parsed against the negotiated minor, not against the newest schema.
    // So a verbatim `@1.1` upsert cannot parse against `@1.2`, and a current app talking to a host that only negotiates `@1.1` silently dropped every terminal-agent upsert it was sent.
    const negotiated = this.session.getNegotiatedSchemaVersion();
    const parsed =
      negotiated !== null && negotiated.major === 1 && negotiated.minor >= 2
        ? hostChatRecordsSubscribeServerFrameSchemaV12.safeParse(envelope)
        : parseV11Frame(envelope);
    // A frame this build cannot parse is dropped rather than guessed at.
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
        // The transport owns the heartbeat: it sends the `ping` client frame on its own interval and does the pong bookkeeping before this handler ever runs.
        return;
      }
    }
  }
}
