/** Inert callback sets for the four typed stream wrappers, each TYPED BY its own contract. */
import type { ArtifactStreamCallbacks } from "@traycer-clients/shared/host-transport/artifact-stream-client";
import type { EpicStateStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-state-stream-client";
import type { EpicStatusStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-status-stream-client";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";

/** 19 members. The legacy `@1` arm carries the whole surface on one stream. */
export const INERT_LEGACY_CALLBACKS: EpicStreamCallbacks = {
  onSnapshot: () => {},
  onEarlyMeta: () => {},
  onUpdate: () => {},
  onAwareness: () => {},
  onPermissionChanged: () => {},
  onEpicDeleted: () => {},
  onArtifactRoomSnapshot: () => {},
  onArtifactRoomUpdate: () => {},
  onArtifactRoomAwareness: () => {},
  onArtifactRoomState: () => {},
  onArtifactRoomDirty: () => {},
  onRootDirty: () => {},
  onDirtySnapshot: () => {},
  onCloudSyncStatus: () => {},
  onMigrationStarted: () => {},
  onMigrationProgress: () => {},
  onMigrationFailed: () => {},
  onMigrationNotAllowed: () => {},
  onConnectionStatus: () => {},
};

/** 5 members. */
export const INERT_STATE_CALLBACKS: EpicStateStreamCallbacks = {
  onSnapshot: () => {},
  onDelta: () => {},
  onResumed: () => {},
  onTrustChanged: () => {},
  onConnectionStatus: () => {},
};

/** 3 members. */
export const INERT_STATUS_CALLBACKS: EpicStatusStreamCallbacks = {
  onSnapshot: () => {},
  onTransition: () => {},
  onConnectionStatus: () => {},
};

/** 6 members. */
export const INERT_ARTIFACT_CALLBACKS: ArtifactStreamCallbacks = {
  onDoc: () => {},
  onDocUpdate: () => {},
  onDocAck: () => {},
  onAwareness: () => {},
  onUnavailable: () => {},
  onConnectionStatus: () => {},
};
