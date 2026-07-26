import type { EpicCloudSyncStatus } from "@traycer/protocol/host/epic/subscribe";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";

/**
 * What the Epic header's sync pill is allowed to claim.
 *
 * `synced` and `offlineChangesSavedLocally` are durability claims. The other
 * states deliberately claim nothing about durability: before the host has
 * confirmed an edit, or while the host-durability snapshot is unknown, this
 * window may be the only place that knows about it.
 */
export type EpicSyncPillState =
  /** Every leg of the chain has acknowledged everything we know about. */
  | "synced"
  /** Work exists, but this label makes no claim about where it is durable. */
  | "syncing"
  /**
   * Host reachable and holding outstanding work durably, cloud link down.
   * The only state that claims local durability, and it is true because the
   * host persists root-doc and artifact-room updates to SQLite while its cloud
   * link is down and replays them on reconnect.
   */
  | "offlineChangesSavedLocally"
  /** GUI↔host is open, but cloud or host-durability state is still unknown. */
  | "connected"
  /** GUI↔host link coming up for the first time on this subscription. */
  | "connecting"
  /** GUI↔host link re-establishing after a prior successful connect. */
  | "reconnecting"
  /** GUI↔host link closed. */
  | "offline";

/**
 * The host's current cloud-durability knowledge for the root doc and every
 * artifact room. `unknown` is deliberately distinct from `clean`: a new GUI
 * connected to an older host, or a new subscription before its atomic
 * `dirtySnapshot`, has not established that no durable work exists.
 */
export type EpicHostDirtyState = "unknown" | "clean" | "dirty";

/**
 * The five independent legs the pill must weigh, plus the bootstrap qualifier
 * that decides "Connecting…" vs "Reconnecting…" copy.
 *
 * Deliberately NOT `OpenEpicState["connectionStatus"]`: that field is a lossy
 * *display* blend of {@link hostTransportStatus} and {@link cloudSyncStatus}
 * (see `deriveConnectionStatus` in the open-epic store), and collapsing the
 * two legs is exactly what makes it useless here - "host unreachable" and
 * "host reachable, cloud down" both read `reconnecting`, yet only the second
 * one may claim the work is saved anywhere.
 */
export interface EpicSyncPillInputs {
  /**
   * Input 1 - the renderer↔host stream. Raw, not the display blend. When this
   * is anything but `open`, unsent local edits sit in the renderer's in-memory
   * queue and nothing durable holds them.
   */
  readonly hostTransportStatus: StreamConnectionStatus;
  /**
   * Input 2 - the host↔cloud link for this Epic, as the host observes it.
   */
  readonly cloudSyncStatus: EpicCloudSyncStatus;
  /**
   * Input 3 - `true` only after a genuine `cloudSyncStatus` frame in this
   * stream cycle. A display default is never proof that the cloud is connected.
   */
  readonly hasFreshCloudSyncStatus: boolean;
  /**
   * Input 4 - cloud-durability state from `epic.subscribe@1.1`'s atomic
   * `dirtySnapshot` and its subsequent `rootDirty` / `artifactRoomDirty`
   * deltas. Old hosts and a new cycle before that snapshot both remain
   * `unknown`; neither may be treated as clean.
   */
  readonly hostDirtyState: EpicHostDirtyState;
  /**
   * Input 5 - the renderer's own replicas (root doc + artifact-room replicas)
   * diverging from what the host has confirmed. Subsumes the store's
   * `hasDirtyArtifactRoomReplicas()`, which is folded into `isDirty` by
   * `resolvePublicDirtyState`.
   */
  readonly hasUnsyncedLocalChanges: boolean;
  /**
   * Presentation qualifier on input 1, not a sixth leg: latched by the first
   * genuine cloud `connected` frame so a first-time bootstrap reads
   * "Connecting…" while a drop after a real connect reads "Reconnecting…".
   */
  readonly hasConnectedOnce: boolean;
}

/**
 * Single source of the sync pill's claim.
 *
 * The ordering below is the honesty contract, and every ambiguous case
 * resolves toward no durability assertion:
 *
 * 1. GUI↔host link down wins over everything. We cannot see the host's cloud
 *    state, and any local edit is renderer-memory-only.
 * 2. Renderer-only work is `syncing`, never "saved locally". An `open`
 *    WebSocket proves neither that the host received the frame nor that it
 *    persisted it.
 * 3. An unknown cloud status or host-durability snapshot yields neutral
 *    `connected`, never `synced`.
 * 4. Link up + cloud up: `synced` requires a clean host snapshot and no local
 *    divergence. Host-durable outstanding work reads `syncing`.
 * 5. Link up + cloud down: only known host-durable work with no renderer-only
 *    divergence may read "saved locally". With nothing outstanding the pill
 *    falls back to reporting the link.
 */
export function deriveEpicSyncPillState(
  inputs: EpicSyncPillInputs,
): EpicSyncPillState {
  if (inputs.hostTransportStatus === "closed") return "offline";
  if (inputs.hostTransportStatus !== "open") {
    return linkComingUpState(inputs.hasConnectedOnce);
  }
  if (inputs.hasUnsyncedLocalChanges) return "syncing";
  if (!inputs.hasFreshCloudSyncStatus || inputs.hostDirtyState === "unknown") {
    return "connected";
  }
  if (inputs.cloudSyncStatus === "connected") {
    return inputs.hostDirtyState === "dirty" ? "syncing" : "synced";
  }
  return inputs.hostDirtyState === "dirty"
    ? "offlineChangesSavedLocally"
    : linkComingUpState(inputs.hasConnectedOnce);
}

function linkComingUpState(
  hasConnectedOnce: boolean,
): Extract<EpicSyncPillState, "connecting" | "reconnecting"> {
  return hasConnectedOnce ? "reconnecting" : "connecting";
}
