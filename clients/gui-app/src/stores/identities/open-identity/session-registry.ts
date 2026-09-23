/**
 * One open-identity session per `(hostId, identityId)`, shared by every
 * consumer that opens the same identity on the same host.
 *
 * Ref-counted and nothing more. The epic registry's live cap and LRU eviction
 * exist because a dozen epics can be open and each holds a worker-backed
 * replica; an identity session is a handful of rows and at most a few small
 * docs, and one tab shows one identity, so the last release disposes it.
 *
 * Keyed by HOST as well as identity: an identity is an account-wide object,
 * but a session is a set of sockets to one host, and a tab is bound to its
 * host for life. Two tabs on two hosts for one identity are two sessions.
 */
import { sessionKeyOf } from "@traycer-clients/shared/replica-runtime";
import type { OpenIdentityStoreHandle } from "./store";

interface RegistryEntry {
  readonly handle: OpenIdentityStoreHandle;
  refCount: number;
}

const entries = new Map<string, RegistryEntry>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** For `useSyncExternalStore`: fires when a session is created or disposed. */
export function subscribeOpenIdentitySessions(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function openIdentitySessionKey(
  hostId: string,
  identityId: string,
): string {
  return sessionKeyOf([hostId, identityId]);
}

/**
 * Acquire the session for `(hostId, identityId)`, building it on first use.
 * Returns the handle and the release that pairs with this acquire.
 */
export function acquireOpenIdentitySession(
  hostId: string,
  identityId: string,
  build: () => OpenIdentityStoreHandle,
): { readonly handle: OpenIdentityStoreHandle; readonly release: () => void } {
  const key = openIdentitySessionKey(hostId, identityId);
  let entry = entries.get(key);
  let created = false;
  if (entry === undefined) {
    entry = { handle: build(), refCount: 0 };
    entries.set(key, entry);
    created = true;
  }
  entry.refCount += 1;
  const held = entry;
  if (created) notify();
  let released = false;
  return {
    handle: held.handle,
    release: () => {
      if (released) return;
      released = true;
      held.refCount -= 1;
      if (held.refCount > 0) return;
      if (entries.get(key) === held) entries.delete(key);
      held.handle.dispose();
      notify();
    },
  };
}

export function peekOpenIdentitySession(
  hostId: string,
  identityId: string,
): OpenIdentityStoreHandle | null {
  return (
    entries.get(openIdentitySessionKey(hostId, identityId))?.handle ?? null
  );
}

export function resetOpenIdentitySessionsForTests(): void {
  for (const entry of entries.values()) entry.handle.dispose();
  entries.clear();
  notify();
}
