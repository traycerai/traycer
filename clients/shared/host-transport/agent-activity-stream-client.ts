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

/**
 * The `agent.activity.subscribe` minor whose open request carries
 * `plane: "local-only"`.
 *
 * Declared HERE rather than beside the renderer's admission predicate, which
 * re-exports it: the admission decides whether to ask for the selector and the
 * pin below decides whether a frame carrying it may go out, and two copies of
 * that number is exactly how an admitted subscribe becomes a rejected one.
 * `shared` cannot import from `gui-app`, so the declaration belongs to the
 * lower layer.
 */
export const AGENT_ACTIVITY_LOCAL_ONLY_MINOR = 2;

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
    // A SELECTED subscribe is PINNED to the minor that understands the
    // selector; an unselected one subscribes plain, exactly as before.
    //
    // A capability rerender cannot close this, by construction rather than by
    // timing: on a rollback the subscribe is written by `sendControlText`
    // BEFORE `onManifest` reports the lower version, so React learns about the
    // downgrade strictly after the frame that needed to know. And `plane` is
    // an OPTIONAL enum, so `prepareStreamSubscribeRequest` STRIPS it and the
    // host serves the CLOUD union to a session that asked for local-only -
    // acquiring a cloud room for a cohort that may hold no verdict. Pinning is
    // re-checked at every handshake AND every reconnect, which is the other
    // half: a stream outlives the process it was opened against.
    if (options.plane === null) {
      this.session = options.wsStreamClient.subscribe(
        "agent.activity.subscribe",
        openRequest,
      );
    } else {
      if (options.wsStreamClient.subscribeAtVersion === undefined) {
        throw new Error("This stream transport cannot pin a schema version");
      }
      this.session = options.wsStreamClient.subscribeAtVersion(
        "agent.activity.subscribe",
        { major: 1, minor: AGENT_ACTIVITY_LOCAL_ONLY_MINOR },
        openRequest,
      );
    }
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
