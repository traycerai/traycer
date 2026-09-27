import { useCallback, useSyncExternalStore } from "react";

/**
 * Which hosts currently have an OPEN `worktree.changed` stream in this
 * renderer.
 *
 * A worktree read can only be trusted "until the host says otherwise" for a
 * host that can say so: the stream's frames - per row, per root, and the
 * catch-up on every (re)subscribe - are what refetch it. A read of any other
 * host (an Epic bound to a different machine, the Sweep popover's other rows)
 * has no such signal and must fall back to time-based freshness.
 *
 * Counted rather than a flag: a host can have more than one mount holding a
 * stream to it, and it stays covered until the last one closes.
 */
const openStreamsByHost = new Map<string, number>();
const listenersByHost = new Map<string, Set<() => void>>();
// One callback per query cache even when several mounted surfaces share the
// host listing. An expired grace needs one active refetch, not one per surface.
const expiryListenersByHost = new Map<
  string,
  Map<object, { count: number; listener: () => void }>
>();
// A transport recovery can notify the broad host-query sweep before this
// stream's replay subscribe completes. Give that subscribe one ordinary
// listing-staleness window to settle; if it cannot, the mounted listing
// observers return to their 60-second fallback.
export const WORKTREE_CHANGED_RECOVERY_GRACE_MS = 60_000;
const recoveryGraceUntilByHost = new Map<string, number>();
const recoveryGraceTimersByHost = new Map<string, number>();

function notify(hostId: string): void {
  for (const listener of listenersByHost.get(hostId) ?? []) listener();
}

function clearRecoveryGraceTimer(hostId: string): void {
  const timer = recoveryGraceTimersByHost.get(hostId);
  if (timer !== undefined) window.clearTimeout(timer);
  recoveryGraceTimersByHost.delete(hostId);
}

function expireRecoveryGrace(hostId: string): void {
  recoveryGraceUntilByHost.delete(hostId);
  const expiryListeners = [
    ...(expiryListenersByHost.get(hostId)?.values() ?? []),
  ].map(({ listener }) => listener);
  notify(hostId);
  for (const listener of expiryListeners) {
    listener();
  }
}

function armRecoveryGraceTimer(hostId: string): void {
  clearRecoveryGraceTimer(hostId);
  const until = recoveryGraceUntilByHost.get(hostId);
  if (until === undefined || (listenersByHost.get(hostId)?.size ?? 0) === 0) {
    return;
  }
  if (until <= Date.now()) {
    expireRecoveryGrace(hostId);
    return;
  }
  recoveryGraceTimersByHost.set(
    hostId,
    window.setTimeout(() => {
      recoveryGraceTimersByHost.delete(hostId);
      if (recoveryGraceUntilByHost.get(hostId) !== until) return;
      expireRecoveryGrace(hostId);
    }, until - Date.now()),
  );
}

export function markWorktreeChangedStreamOpen(hostId: string): void {
  openStreamsByHost.set(hostId, (openStreamsByHost.get(hostId) ?? 0) + 1);
  recoveryGraceUntilByHost.delete(hostId);
  clearRecoveryGraceTimer(hostId);
  notify(hostId);
}

export function markWorktreeChangedStreamClosed(hostId: string): void {
  const open = openStreamsByHost.get(hostId) ?? 0;
  if (open <= 1) {
    openStreamsByHost.delete(hostId);
    if (open === 1 && (listenersByHost.get(hostId)?.size ?? 0) > 0) {
      recoveryGraceUntilByHost.set(
        hostId,
        Date.now() + WORKTREE_CHANGED_RECOVERY_GRACE_MS,
      );
      armRecoveryGraceTimer(hostId);
    }
  } else openStreamsByHost.set(hostId, open - 1);
  notify(hostId);
}

export function isWorktreeChangedStreamOpen(hostId: string | null): boolean {
  return hostId !== null && (openStreamsByHost.get(hostId) ?? 0) > 0;
}

/**
 * One expiry action per owner, shared by every mounted consumer of its cache.
 * The owner is a QueryClient for the host listing; callers register only while
 * their query is enabled. This stays registered across a host-binding change
 * when a different surface still reads the old host.
 */
export function subscribeWorktreeChangedCoverageExpired(
  hostId: string,
  owner: object,
  listener: () => void,
): () => void {
  let byOwner = expiryListenersByHost.get(hostId);
  if (byOwner === undefined) {
    byOwner = new Map();
    expiryListenersByHost.set(hostId, byOwner);
  }
  const entry = byOwner.get(owner);
  if (entry === undefined) byOwner.set(owner, { count: 1, listener });
  else entry.count += 1;
  return () => {
    const listeners = expiryListenersByHost.get(hostId);
    const current = listeners?.get(owner);
    if (current === undefined) return;
    current.count -= 1;
    if (current.count === 0) listeners?.delete(owner);
    if (listeners?.size === 0) expiryListenersByHost.delete(hostId);
  };
}

/** The replay stream is live, or is still within its bounded reconnect gap. */
export function isWorktreeChangedStreamCovered(hostId: string | null): boolean {
  if (hostId === null) return false;
  return (
    isWorktreeChangedStreamOpen(hostId) ||
    (recoveryGraceUntilByHost.get(hostId) ?? 0) > Date.now()
  );
}

/** Reactive coverage for query options that must fall back on stream loss. */
export function useWorktreeChangedStreamOpen(hostId: string | null): boolean {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (hostId === null) return () => undefined;
      let listeners = listenersByHost.get(hostId);
      if (listeners === undefined) {
        listeners = new Set();
        listenersByHost.set(hostId, listeners);
      }
      listeners.add(listener);
      armRecoveryGraceTimer(hostId);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          listenersByHost.delete(hostId);
          clearRecoveryGraceTimer(hostId);
          recoveryGraceUntilByHost.delete(hostId);
        }
      };
    },
    [hostId],
  );
  const getSnapshot = useCallback(
    () => isWorktreeChangedStreamOpen(hostId),
    [hostId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** Reactive freshness coverage, including only the bounded reconnect gap. */
export function useWorktreeChangedStreamCovered(
  hostId: string | null,
): boolean {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (hostId === null) return () => undefined;
      let listeners = listenersByHost.get(hostId);
      if (listeners === undefined) {
        listeners = new Set();
        listenersByHost.set(hostId, listeners);
      }
      listeners.add(listener);
      armRecoveryGraceTimer(hostId);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          listenersByHost.delete(hostId);
          clearRecoveryGraceTimer(hostId);
          recoveryGraceUntilByHost.delete(hostId);
        }
      };
    },
    [hostId],
  );
  const getSnapshot = useCallback(
    () => isWorktreeChangedStreamCovered(hostId),
    [hostId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** Test-only. */
export function resetWorktreeChangedCoverageForTests(): void {
  const hosts = new Set([
    ...openStreamsByHost.keys(),
    ...recoveryGraceUntilByHost.keys(),
  ]);
  for (const hostId of recoveryGraceTimersByHost.keys()) {
    clearRecoveryGraceTimer(hostId);
  }
  openStreamsByHost.clear();
  recoveryGraceUntilByHost.clear();
  expiryListenersByHost.clear();
  for (const hostId of hosts) notify(hostId);
}
