import { providersChangedServerFrameSchema } from "@traycer/protocol/host/providers-changed-stream";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { IHostStreamClient } from "./host-stream-client";

export class ProvidersChangedStreamClient {
  private readonly session: IStreamSession;
  private closed = false;

  constructor(options: {
    readonly wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>;
    readonly onChanged: (providerId: ProviderId) => void;
    readonly onConnectionStatus: (
      status: StreamConnectionStatus,
      reason: StreamCloseReason | null,
    ) => void;
  }) {
    this.session = options.wsStreamClient.subscribe("providers.changed", {});
    this.session.onServerFrame(
      (envelope: StreamFrameEnvelope, binaryPayload: Uint8Array | null) => {
        if (binaryPayload !== null) return;
        const parsed = providersChangedServerFrameSchema.safeParse(envelope);
        if (!parsed.success || parsed.data.kind !== "changed") return;
        options.onChanged(parsed.data.providerId);
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
