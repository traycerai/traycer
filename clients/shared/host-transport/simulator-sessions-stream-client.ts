import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  simulatorSessionsServerFrameSchemaV10,
  type SimulatorSessionsClientFrame,
  type SimulatorSessionsOpenRequest,
  type SimulatorSessionsServerFrame,
} from "@traycer/protocol/host/simulator/stream-contracts";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { IHostStreamClient } from "./host-stream-client";

export interface SimulatorSessionsStreamCallbacks {
  /**
   * One validated `simulator.sessions` server frame: the `snapshot` on
   * subscribe (and again after every reconnect), then each `stateChanged`
   * with only the fields that moved. Handed over whole so one reducer folds
   * both into the inventory a tile, the sidebar and Settings read.
   */
  readonly onServerFrame: (frame: SimulatorSessionsServerFrame) => void;
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

export type SimulatorSessionsStreamClientOptions =
  SimulatorSessionsOpenRequest & {
    readonly wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>;
    readonly callbacks: SimulatorSessionsStreamCallbacks;
  };

/**
 * Typed wrapper over one `simulator.sessions` subscription: one epic's view
 * of the host's simulators, pack and hub state, and sessions. Served on the
 * `@1.0` line only, whose server frames this parses with
 * `simulatorSessionsServerFrameSchemaV10`; a later minor moves that pin
 * (`protocol/README.md`, "Opening a new minor on a stream").
 */
export class SimulatorSessionsStreamClient {
  private readonly session: IStreamSession;
  private readonly callbacks: SimulatorSessionsStreamCallbacks;
  private closed: boolean;

  constructor(options: SimulatorSessionsStreamClientOptions) {
    const { wsStreamClient, callbacks, ...openRequest } = options;
    this.callbacks = callbacks;
    this.closed = false;
    this.session = wsStreamClient.subscribe("simulator.sessions", openRequest);
    this.session.onServerFrame((envelope) => {
      this.handleServerFrame(envelope);
    });
    this.session.onStatusChange((status, reason) => {
      this.callbacks.onConnectionStatus(status, reason);
    });
  }

  /** `refresh` re-runs discovery on the host. */
  sendClientFrame(frame: SimulatorSessionsClientFrame): void {
    if (this.closed) return;
    this.session.sendClientFrame(frame, null);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.session.close();
  }

  private handleServerFrame(envelope: StreamFrameEnvelope): void {
    const parsed = simulatorSessionsServerFrameSchemaV10.safeParse(envelope);
    if (!parsed.success) {
      // Issue paths only: the inventory carries simulator names and the
      // pack's failure reason, neither of which belongs in a console line.
      const issuePaths = parsed.error.issues
        .map((issue) =>
          issue.path.length > 0 ? issue.path.join(".") : "(root)",
        )
        .join(", ");
      console.warn(
        `[stream] simulator.sessions frame failed schema validation (kind=${envelope.kind}, issues=[${issuePaths}]); dropping frame`,
      );
      return;
    }
    this.callbacks.onServerFrame(parsed.data);
  }
}
