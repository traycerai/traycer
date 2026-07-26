import type { EpicCloudSyncStatus } from "@traycer/protocol/host/epic/subscribe";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";

/**
 * What the Epic header's sync pill is allowed to claim.
 *
 * Three of these are durability claims (`synced`, `syncing`,
 * `offlineChangesSavedLocally`); the other three describe the GUI↔host link
 * and deliberately claim nothing about durability, because while that link is
 * down the only copy of an unsent edit lives in this window's memory.
 */
export type EpicSyncPillState =
  /** Every leg of the chain has acknowledged everything we know about. */
  | "synced"
  /** Host reachable, cloud link up, work still outstanding on some leg. */
  | "syncing"
  /**
   * Host reachable and holding outstanding work durably, cloud link down.
   * The only state that claims local durability, and it is true because the
   * host persists root-doc and artifact-room updates to SQLite while its cloud
   * link is down and replays them on reconnect.
   */
  | "offlineChangesSavedLocally"
  /** GUI↔host link coming up for the first time on this subscription. */
  | "connecting"
  /** GUI↔host link re-establishing after a prior successful connect. */
  | "reconnecting"
  /** GUI↔host link closed. */
  | "offline";

/**
 * The four independent legs the pill must weigh, plus the bootstrap qualifier
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
   * `epicCloudSyncStatusSchema` calls this "the source of truth for whether
   * 'All changes synced' is safe to show", and until now the pill saw it only
   * through the blend above.
   */
  readonly cloudSyncStatus: EpicCloudSyncStatus;
  /**
   * Input 3 - any artifact room for which the host holds work its cloud
   * connection has not acknowledged (`epic.subscribe@1.1` `artifactRoomDirty`).
   * This is the leg that was entirely invisible when the pill reported "All
   * changes synced" over 49 artifact bodies that existed nowhere but the
   * authoring host.
   *
   * A host older than `@1.1` never emits the frame, so this stays `false` and
   * the derivation degrades to exactly the inputs it had before.
   */
  readonly hasDirtyArtifactRooms: boolean;
  /**
   * Input 4 - the renderer's own replicas (root doc + artifact-room replicas)
   * diverging from what the host has confirmed. Subsumes the store's
   * `hasDirtyArtifactRoomReplicas()`, which is folded into `isDirty` by
   * `resolvePublicDirtyState`.
   */
  readonly hasUnsyncedLocalChanges: boolean;
  /**
   * Presentation qualifier on input 1, not a fifth leg: latched by the first
   * genuine cloud `connected` frame so a first-time bootstrap reads
   * "Connecting…" while a drop after a real connect reads "Reconnecting…".
   */
  readonly hasConnectedOnce: boolean;
}

/**
 * Single source of the sync pill's claim.
 *
 * The ordering below is the honesty contract, and every ambiguous case
 * resolves toward "not synced":
 *
 * 1. GUI↔host link down wins over everything. We cannot see the host's cloud
 *    state, and any local edit is renderer-memory-only, so the pill reports
 *    the link and makes no durability claim at all.
 * 2. Link up + cloud up: `synced` requires BOTH dirtiness legs clean. Either
 *    one alone forces `syncing`.
 * 3. Link up + cloud down + anything outstanding: the host has it and will
 *    replay it, which is the one case where "saved locally" is a true
 *    statement. With nothing outstanding there is nothing to save, so the pill
 *    falls back to reporting the link.
 *
 * Known and accepted: a healthy connected room mid-save reads clean until the
 * host's ~2s persist debounce writes a pending row, because `artifactRoomDirty`
 * fires on websocket and pending-row transitions rather than per doc update.
 * Input 4 covers the renderer-side leg of that window; the pill deliberately
 * does not flicker on every keystroke.
 */
export function deriveEpicSyncPillState(
  inputs: EpicSyncPillInputs,
): EpicSyncPillState {
  const hasOutstandingWork =
    inputs.hasDirtyArtifactRooms || inputs.hasUnsyncedLocalChanges;

  if (inputs.hostTransportStatus === "closed") return "offline";
  if (inputs.hostTransportStatus !== "open") {
    return linkComingUpState(inputs.hasConnectedOnce);
  }
  if (inputs.cloudSyncStatus === "connected") {
    return hasOutstandingWork ? "syncing" : "synced";
  }
  return hasOutstandingWork
    ? "offlineChangesSavedLocally"
    : linkComingUpState(inputs.hasConnectedOnce);
}

function linkComingUpState(
  hasConnectedOnce: boolean,
): Extract<EpicSyncPillState, "connecting" | "reconnecting"> {
  return hasConnectedOnce ? "reconnecting" : "connecting";
}
