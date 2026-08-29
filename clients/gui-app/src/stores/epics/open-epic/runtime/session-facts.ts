/**
 * The cross-plane facts every plane reads and only the control plane writes.
 *
 * In the closure these were six `let`s that anything could touch: the artifact
 * room tier read `transportStatus` and `currentRole`, the overlay's dead sweep
 * read `hasFreshRootSnapshotForOpenCycle`, and the stream callbacks wrote all
 * of them. The coupling is genuine and is not removed by relocation - a body
 * write really does depend on the transport, the role AND this cycle's
 * snapshot - so it is made explicit instead: one writer, a read-only view for
 * everyone else.
 */
import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";
import type { EpicCloudSyncStatus } from "@traycer/protocol/host/epic/subscribe";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";

export function isWritablePermissionRole(role: PermissionRole | null): boolean {
  return role !== "viewer" && role !== null;
}

/**
 * Derives the VISIBLE connection status shown in the UI pill: an open
 * renderer↔host transport still reads as "reconnecting" while the host's cloud
 * link is down. This is display-only - outbound write routing gates on
 * `transportStatus` directly (the host owns durable offline persistence and
 * replay), so a cloud-sync drop must NOT stop edits from reaching the local
 * host.
 *
 * `hasConnectedOnce` separates first-time bootstrapping from a genuine
 * reconnect: before the initial successful connect, the transport handshake and
 * the first cloud-sync catch-up are "connecting", not "reconnecting", so a
 * freshly created/opened Epic never flashes "Reconnecting…" while it's really
 * just coming up for the first time.
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

/**
 * The read-only view of the session's cross-plane facts.
 *
 * Getters rather than a snapshot object: every one of these moves under the
 * reader's feet (a frame arrives between two steps of the same handler), and a
 * captured value is how a body write gets gated on a transport status that was
 * true one microtask ago.
 */
export interface EpicSessionFacts {
  /**
   * Raw renderer↔host stream status. Outbound gating reads THIS, never the
   * blended visible status: when the host's cloud link drops the pill shows
   * "reconnecting" but the LOCAL transport stays open, and edits must keep
   * flowing to the host, which durably persists them while offline and replays
   * them on restart. Queuing on the blended status instead strands them in
   * memory and loses them on restart.
   */
  transportStatus(): StreamConnectionStatus;
  /**
   * The write-gating role - the SNAPSHOT-derived one, never the early-meta
   * projection. The early role is the host's view of cloud
   * `epic.permission.role` and can disagree with the snapshot's (which factors
   * in team memberships), so letting it gate writes would fail closed for a
   * team-derived owner and fail open for a stale-cached editor.
   */
  permissionRole(): PermissionRole | null;
  /**
   * The role a ROOT-doc write or an optimistic stamp gates on: the
   * snapshot-derived role when this cycle has one, otherwise the last DISPLAYED
   * role, which the early-meta frame may have set.
   *
   * Deliberately different from {@link permissionRole}, and the difference is
   * load-bearing in both directions. Artifact-body writes gate on the bare
   * snapshot role because sending one as a viewer hits the host's guarded
   * `applyCollabUpdate`, which refuses the mutate AND evicts the warm slot,
   * tearing the room down mid-open. Root writes and optimistic stamps fall back
   * to the displayed role because they happen in the ~8s before the snapshot
   * lands, where refusing everything would silently drop a legitimate owner's
   * edits.
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
  /**
   * Why this session cannot serve normally, or `null` when nothing is wrong.
   *
   * Feeds every plane's `ClassFreshness.degradedReason`, which the shared
   * contract requires to be non-null exactly when the status is `"degraded"`.
   * A session-wide fact rather than a per-plane one because all three causes -
   * access lost, a fatal close, a failed migration - stop every plane at once.
   */
  degradedReason(): string | null;
}
