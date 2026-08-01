import {
  agentActivitySubscribeServerFrameSchema,
  type AgentActivityByEpic,
} from "@traycer/protocol/host/agent/activity";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { WsStreamClient } from "./ws-stream-client";

export interface AgentActivityStreamCallbacks {
  readonly onSnapshot: (byEpic: AgentActivityByEpic) => void;
  readonly onUpdate: (byEpic: AgentActivityByEpic) => void;
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

export interface AgentActivityStreamClientOptions {
  readonly wsStreamClient: WsStreamClient<HostStreamRpcRegistry>;
  readonly callbacks: AgentActivityStreamCallbacks;
}

/** Typed client for the optional host-local activity stream. */
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
    if (frame.kind === "snapshot") {
      this.options.callbacks.onSnapshot(frame.byEpic);
    } else if (frame.kind === "update") {
      this.options.callbacks.onUpdate(frame.byEpic);
    }
  }
}
