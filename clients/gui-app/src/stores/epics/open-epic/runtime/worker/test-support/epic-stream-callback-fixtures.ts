/**
 * Inert callback sets for the four typed stream wrappers, each TYPED BY its
 * own contract.
 *
 * ONE source for four contracts totalling 33 members, so the next member added
 * to any of them fails to compile here and nowhere else.
 *
 * These had to be WRITTEN rather than reused, and the reason is worth knowing
 * before reaching for one: nothing in the codebase constructs an
 * `EpicStreamCallbacks`. Every existing suite CAPTURES the set the runtime
 * built and handed to a fake factory (`store.test.ts`'s `FakeStreamHandle`,
 * `lane-legacy-availability-equivalence.test.ts`'s `live()`), because the
 * runtime is always the constructor. A test that calls a stream factory
 * DIRECTLY - as the composition suite does, to pin what the factory opens - is
 * standing in for the runtime, and it is the only caller that needs a literal.
 *
 * They are inert on purpose. A fixture that recorded would invite assertions
 * about what the wrapper dispatches, which is the wrapper's own suite's job;
 * what the composition suite asserts is what reached the SOCKET.
 */
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
