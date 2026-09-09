import {
  agentActivitySubscribeServerFrameSchema,
  type AgentActivityByEpic,
  type AgentActivityCloudSyncStatus,
  type AgentActivityPlaneSelector,
  type AgentActivityServedBy,
  type AgentActivitySubscribeOpenRequest,
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
  /**
   * `cloudSyncStatus` is the host's cloud-link status when it built the union;
   * `null` is no claim (local plane, or a `1.0` host that predates the field -
   * the live schema defaults the absent key to `null`).
   */
  readonly onState: (
    servedBy: AgentActivityServedBy,
    byEpic: AgentActivityByEpic,
    cloudSyncStatus: AgentActivityCloudSyncStatus | null,
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
  /**
   * `"local-only"` asks a `@1.2` host to serve this subscription from its own
   * tracker and acquire no cloud room; `null` leaves the plane to the host,
   * which is what every caller did before the selector existed.
   *
   * Required rather than optional so a new call site has to state which cohort
   * it is opening for. The decision belongs to whoever knows the session's
   * cloud verdict, and a defaulted `null` would let that caller forget to make
   * it - silently restoring the behaviour this option exists to change.
   */
  readonly plane: AgentActivityPlaneSelector | null;
}

/** Typed client for the host-selected local/cloud activity stream. */
export class AgentActivityStreamClient {
  private readonly session: IStreamSession;
  private closed = false;

  constructor(private readonly options: AgentActivityStreamClientOptions) {
    // `{}` rather than `{ plane: null }`: `plane` is an OPTIONAL enum on the
    // wire, so a literal `null` fails the host's parse rather than reading as
    // "no preference".
    const openRequest: AgentActivitySubscribeOpenRequest =
      options.plane === null ? {} : { plane: options.plane };
    this.session = options.wsStreamClient.subscribe(
      "agent.activity.subscribe",
      openRequest,
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
      this.options.callbacks.onState(
        frame.servedBy,
        frame.byEpic,
        frame.cloudSyncStatus,
      );
    }
  }
}
