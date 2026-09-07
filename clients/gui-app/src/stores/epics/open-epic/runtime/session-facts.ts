/** The cross-plane facts every plane reads and only the control plane writes. */
import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";
import type { EpicCloudSyncStatus } from "@traycer/protocol/host/epic/subscribe";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";

/** Re-exported, not defined here. */
export { isWritablePermissionRole } from "@traycer-clients/shared/epic/permission-role";

/**
 * Derives the VISIBLE connection status shown in the UI pill: an open renderer↔host transport
 * still reads as "reconnecting" while the host's cloud link is down.
 */
export function deriveConnectionStatus(
  transportStatus: StreamConnectionStatus,
  cloudSyncStatus: EpicCloudSyncStatus,
  hasConnectedOnce: boolean,
): StreamConnectionStatus {
  if (transportStatus !== "open") {
    // A transport that has never opened is bootstrapping; only a drop after a
    // prior connect is a "reconnecting". "closed" stays "closed" either way.
    if (transportStatus === "reconnecting" && !hasConnectedOnce) {
      return "connecting";
    }
    return transportStatus;
  }
  if (cloudSyncStatus === "connected") {
    return "open";
  }
  // Transport open, cloud link still catching up: bootstrapping the first
  // time, a genuine reconnect once we've been connected before.
  return hasConnectedOnce ? "reconnecting" : "connecting";
}

/** The read-only view of the session's cross-plane facts. */
export interface EpicSessionFacts {
  /** Raw renderer↔host stream status. */
  transportStatus(): StreamConnectionStatus;
  /** The write-gating role - the SNAPSHOT-derived one, never the early-meta projection. */
  permissionRole(): PermissionRole | null;
  /**
   * The role a ROOT-doc write or an optimistic stamp gates on: the snapshot-derived role when this
   * cycle has one, otherwise the last DISPLAYED role, which the early-meta frame may have set.
   */
  writeGateRole(): PermissionRole | null;
  isWritableRole(): boolean;
  /** Whether this open cycle has received its authoritative root snapshot. */
  hasFreshRootSnapshotForOpenCycle(): boolean;
  /**
   * The three-way gate on sending artifact-body writes: the transport is open,
   * this cycle has its root snapshot, and the role can write.
   */
  canSendBodyWrites(): boolean;
  /** Why this session cannot serve normally, or `null` when nothing is wrong. */
  degradedReason(): string | null;
}
