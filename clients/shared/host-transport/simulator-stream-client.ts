import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  simulatorStreamServerFrameSchemaV10,
  type SimulatorStreamClientFrame,
  type SimulatorStreamOpenRequest,
  type SimulatorStreamServerFrame,
} from "@traycer/protocol/host/simulator/stream-contracts";
import type {
  IStreamSession,
  StatusChangeHandler,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { IHostStreamClient } from "./host-stream-client";

export interface SimulatorStreamCallbacks {
  /**
   * `videoBytes` is the paired binary WS frame for a `video` kind and null
   * for every text kind: one AVCC envelope's payload, one SEMU packet or one
   * JPEG, as `frame.unit` says. Delivered as a separate parameter for the
   * same reason the browser screencast does it: the payload arrives
   * out-of-band, not as a field on the envelope.
   */
  readonly onServerFrame: (
    frame: SimulatorStreamServerFrame,
    videoBytes: Uint8Array | null,
  ) => void;
  readonly onConnectionStatus: StatusChangeHandler;
}

export type SimulatorStreamClientOptions = SimulatorStreamOpenRequest & {
  readonly wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>;
  readonly callbacks: SimulatorStreamCallbacks;
};

/**
 * Typed wrapper over one `simulator.stream` subscription: one viewer's video
 * from, and input to, one simulator on the connection's host. The host
 * reconnects its own upstream after a hub restart, so a viewer keeps this one
 * session through it; a transport drop re-declares the subscription like any
 * other stream.
 *
 * Served on the `@1.0` line only, whose server frames this parses with
 * `simulatorStreamServerFrameSchemaV10`; a later minor moves that pin
 * (`protocol/README.md`, "Opening a new minor on a stream").
 */
export class SimulatorStreamClient {
  private readonly session: IStreamSession;
  private readonly callbacks: SimulatorStreamCallbacks;
  private closed: boolean;

  constructor(options: SimulatorStreamClientOptions) {
    const { wsStreamClient, callbacks, ...openRequest } = options;
    this.callbacks = callbacks;
    this.closed = false;
    this.session = wsStreamClient.subscribe("simulator.stream", openRequest);
    this.session.onServerFrame((envelope, binaryPayload) => {
      this.handleServerFrame(envelope, binaryPayload);
    });
    this.session.onStatusChange((status, reason, retryCause, continuity) => {
      this.callbacks.onConnectionStatus(status, reason, retryCause, continuity);
    });
  }

  /**
   * Input and stream control, fire-and-forget. A viewer without owner rights
   * may send these; the host answers with `inputState { connected: false }`
   * and forwards nothing.
   */
  sendClientFrame(frame: SimulatorStreamClientFrame): void {
    if (this.closed) return;
    this.session.sendClientFrame(frame, null);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.session.close();
  }

  private handleServerFrame(
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ): void {
    const parsed = simulatorStreamServerFrameSchemaV10.safeParse(envelope);
    if (!parsed.success) {
      const issuePaths = parsed.error.issues
        .map((issue) =>
          issue.path.length > 0 ? issue.path.join(".") : "(root)",
        )
        .join(", ");
      console.warn(
        `[stream] simulator.stream frame failed schema validation (kind=${envelope.kind}, issues=[${issuePaths}]); dropping frame`,
      );
      return;
    }
    this.callbacks.onServerFrame(parsed.data, binaryPayload);
  }
}
