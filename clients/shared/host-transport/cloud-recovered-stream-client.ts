import {
  CLOUD_RECOVERED_STREAM_METHOD,
  cloudRecoveredServerFrameSchema,
} from "@traycer/protocol/host/cloud-recovered-stream";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { IHostStreamClient } from "./host-stream-client";

/**
 * One host's cloud-recovery doorbell (`cloud.recovered.subscribe`). Every
 * `recovered` frame reaches `onRecovered`; the frame carries nothing else.
 */
export class CloudRecoveredStreamClient {
  private readonly session: IStreamSession;
  private closed = false;

  constructor(options: {
    readonly wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>;
    readonly onRecovered: () => void;
    readonly onConnectionStatus: (
      status: StreamConnectionStatus,
      reason: StreamCloseReason | null,
    ) => void;
  }) {
    this.session = options.wsStreamClient.subscribe(
      CLOUD_RECOVERED_STREAM_METHOD,
      {},
    );
    this.session.onServerFrame(
      (envelope: StreamFrameEnvelope, binaryPayload: Uint8Array | null) => {
        if (binaryPayload !== null) return;
        const parsed = cloudRecoveredServerFrameSchema.safeParse(envelope);
        if (!parsed.success || parsed.data.kind !== "recovered") return;
        options.onRecovered();
      },
    );
    this.session.onStatusChange(options.onConnectionStatus);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.session.close();
  }
}
