import {
  terminalPlainSubscribeListServerFrameSchema,
  type TerminalPlainSubscribeListServerFrame,
} from "@traycer/protocol/host/terminal/plain-subscribe-list";
import type { PlainTerminalScope } from "@traycer/protocol/host/terminal/plain-schemas";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { IHostStreamClient } from "./host-stream-client";

export interface PlainTerminalListStreamCallbacks {
  readonly onState: (
    frame: Extract<
      TerminalPlainSubscribeListServerFrame,
      { readonly kind: "state" }
    >,
  ) => void;
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

export interface PlainTerminalListStreamClientOptions {
  readonly wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>;
  readonly scope: PlainTerminalScope;
  readonly callbacks: PlainTerminalListStreamCallbacks;
}

/** Typed client surface for replacement-state durable terminal collection. */
export class PlainTerminalListStreamClient {
  private readonly session: IStreamSession;
  private readonly callbacks: PlainTerminalListStreamCallbacks;
  private closed: boolean;

  constructor(options: PlainTerminalListStreamClientOptions) {
    this.callbacks = options.callbacks;
    this.closed = false;
    this.session = options.wsStreamClient.subscribe(
      "terminal.plain.subscribeList",
      { scope: options.scope },
    );
    this.session.onServerFrame((envelope, binaryPayload) => {
      this.handleServerFrame(envelope, binaryPayload);
    });
    this.session.onStatusChange((status, reason) => {
      this.callbacks.onConnectionStatus(status, reason);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.session.close();
  }

  private handleServerFrame(
    envelope: StreamFrameEnvelope,
    _binaryPayload: Uint8Array | null,
  ): void {
    const parsed =
      terminalPlainSubscribeListServerFrameSchema.safeParse(envelope);
    if (!parsed.success) {
      const issuePaths = parsed.error.issues
        .map((issue) =>
          issue.path.length > 0 ? issue.path.join(".") : "(root)",
        )
        .join(", ");
      console.warn(
        `[stream] terminal.plain.subscribeList frame failed schema validation (kind=${envelope.kind}, issues=[${issuePaths}]); dropping frame`,
      );
      return;
    }

    const frame = parsed.data;
    switch (frame.kind) {
      case "state": {
        this.callbacks.onState(frame);
        return;
      }
      case "pong": {
        return;
      }
      default: {
        const unhandled: never = frame;
        console.warn(
          `[stream] terminal.plain.subscribeList unhandled frame kind; dropping frame`,
          unhandled,
        );
        return;
      }
    }
  }
}
