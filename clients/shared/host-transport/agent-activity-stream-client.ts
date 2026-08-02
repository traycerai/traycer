import {
  agentActivitySubscribeServerFrameSchema,
  type AgentActivityByEpic,
  type AgentActivityServedBy,
} from "@traycer/protocol/host/agent/activity";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { IHostStreamClient } from "./host-stream-client";

export interface AgentActivityStreamCallbacks {
  readonly onState: (
    servedBy: AgentActivityServedBy,
    byEpic: AgentActivityByEpic,
  ) => void;
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

export interface AgentActivityStreamClientOptions {
  // `IHostStreamClient`, not the concrete `WsStreamClient`: this client only
  // calls `.subscribe()`, and every sibling stream client here takes the
  // interface so a remote host can supply its own transport. Arrived from main
  // on the concrete type because that branch had no remote transport yet.
  readonly wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>;
  readonly callbacks: AgentActivityStreamCallbacks;
}

/** Typed client for the host-selected local/cloud activity stream. */
export class AgentActivityStreamClient {
  private readonly session: IStreamSession;
  private closed = false;

  constructor(private readonly options: AgentActivityStreamClientOptions) {
    this.session = options.wsStreamClient.subscribe(
      "agent.activity.subscribe",
      {},
    );
    this.session.onServerFrame((envelope) => {
      this.handleServerFrame(envelope);
    });
    this.session.onStatusChange((status, reason) => {
      this.options.callbacks.onConnectionStatus(status, reason);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.session.close();
  }

  private handleServerFrame(envelope: StreamFrameEnvelope): void {
    const parsed = agentActivitySubscribeServerFrameSchema.safeParse(envelope);
    if (!parsed.success) return;
    const frame = parsed.data;
    if (frame.kind === "state") {
      this.options.callbacks.onState(frame.servedBy, frame.byEpic);
    }
  }
}
