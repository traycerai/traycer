/**
 * Ticket 21 slice 4 fix round, finding 2: reports which chat `instanceId`s
 * are currently remote-deleted, per `ActiveTabBody`'s own
 * `computeIsRemoteDeleted` - an epic-session-scoped React computation
 * (`useEpicSnapshotLoaded`/`useEpicArtifact` read the CURRENT epic's Y.Doc
 * projection store via `EpicSessionContext`) that `tile-surface-membership.ts`'s
 * outside-React, store-subscription-driven computation cannot reach
 * directly. Same registry-read shape as `chat-tab-viewport-handoff.ts`'s live
 * capture map, reused rather than reinvented.
 *
 * Membership subscribes to `subscribeChatRemoteDeletion` so a remote deletion
 * arriving mid-session (a Y.Doc sync event, unrelated to any canvas/tab-strip
 * store change) still triggers a membership recompute.
 */
type RemoteDeletionListener = () => void;

const remoteDeletedInstanceIds = new Set<string>();
const listeners = new Set<RemoteDeletionListener>();

/**
 * Called from `ActiveTabBody`'s own effect for chat tiles only - reports the
 * SAME `isRemoteDeleted` value it already computed for its inline
 * `DeletedArtifactBody` branch. A no-op unregister (`isRemoteDeleted: false`)
 * on unmount prevents a stale `true` entry from outliving its tab.
 */
export function reportChatRemoteDeletionState(
  instanceId: string,
  isRemoteDeleted: boolean,
): void {
  const wasDeleted = remoteDeletedInstanceIds.has(instanceId);
  if (wasDeleted === isRemoteDeleted) return;
  if (isRemoteDeleted) {
    remoteDeletedInstanceIds.add(instanceId);
  } else {
    remoteDeletedInstanceIds.delete(instanceId);
  }
  listeners.forEach((listener) => listener());
}

export function isChatRemoteDeleted(instanceId: string): boolean {
  return remoteDeletedInstanceIds.has(instanceId);
}

export function subscribeChatRemoteDeletion(
  listener: RemoteDeletionListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetChatRemoteDeletionRegistryForTesting(): void {
  const hadDeletedInstances = remoteDeletedInstanceIds.size > 0;
  remoteDeletedInstanceIds.clear();
  if (hadDeletedInstances) {
    listeners.forEach((listener) => listener());
  }
}
