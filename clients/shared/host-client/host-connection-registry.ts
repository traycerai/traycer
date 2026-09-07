import {
  leaseEquals,
  type HostLeaseSnapshot,
} from "../host-selection/selection-authority-contract";
import {
  createHostReconnectEngine,
  type HostReconnectEngine,
} from "./host-connection-reconnect-engine";
import type { TimerHandle } from "../host-transport/timer-handle";
import type { Disposable } from "../platform/uri-callback";
import type { HostDirectoryEntry } from "./host-directory";
import {
  hostUnavailability,
  isRelayFuseRecoveryCandidate,
  isRemoteHostDirectoryEntry,
} from "./remote-fetcher";

/**
 * The window's connection registry (redesign connection-registry §1).
 * With nothing installed every subscription is a no-op and every read answers `null` - a bare harness gets the same answers an unbound client always gave, rather than a throw from a module nobody in that harness wired.
 */

export interface HostConnectionDirectorySource {
  readonly findById: (hostId: string) => HostDirectoryEntry | null;
  /** The directory's list-wide change event; the registry does the per-host part. */
  readonly onDirectoryChanged: (listener: () => void) => Disposable;
}

/**
 * Where the registry reads leases from.
 * Deliberately a port rather than state: the authority engine is the only producer of lease status in this app, and a registry that cached its own copy would be the second status vocabulary the epic exists to delete.
 */
export interface HostConnectionLeaseSource {
  readonly leaseFor: (hostId: string) => HostLeaseSnapshot | null;
  readonly onLeasesChanged: (listener: () => void) => Disposable;
}

export interface HostConnectionRegistrySource {
  readonly directory: HostConnectionDirectorySource;
  /** `null` in shells with no selection authority attached (tests, previews). */
  readonly leases: HostConnectionLeaseSource | null;
}

/**
 * A consumer's hold on one host's connection.
 * Ref-counted: `release()` drops this consumer's reference, and the registry keeps the host warm for {@link HOST_CONNECTION_LINGER_MS} after the last one lets go.
 */
export interface HostConnectionLease {
  readonly hostId: string;
  /** The authority's verdict, or `null` before any lease has been published. */
  readonly status: () => HostLeaseSnapshot | null;
  /** This host's directory row, or `null` while unresolved. */
  readonly entry: () => HostDirectoryEntry | null;
  /** Fires when this host's row or lease moves. */
  readonly onChanged: (listener: () => void) => () => void;
  /** The reconnect policy for this host (§6). */
  readonly reconnect: HostReconnectEngine;
  readonly release: () => void;
}

export const HOST_CONNECTION_LINGER_MS = 60_000;

interface HostRecord {
  readonly hostId: string;
  refCount: number;
  lingerTimer: TimerHandle | null;
  /** Last row this host resolved to, for the change-suppression compare. */
  entry: HostDirectoryEntry | null;
  /** Last lease this host published, same purpose. */
  lease: HostLeaseSnapshot | null;
  /** This host's ONE reconnect engine; see {@link HostConnectionLease}. */
  readonly reconnect: HostReconnectEngine;
  readonly listeners: Set<() => void>;
}

const records = new Map<string, HostRecord>();
const anyRowListeners = new Set<() => void>();
let source: HostConnectionRegistrySource | null = null;
let sourceSubscriptions: Disposable[] = [];

/**
 * Installs the window's source.
 * Called by `HostRuntime.start()`; calling it again replaces the previous wiring (the HMR / re-mount case) without dropping subscribers - they are attached to hosts, not to the source.
 */
export function installHostConnectionRegistrySource(
  next: HostConnectionRegistrySource,
): void {
  disposeSourceSubscriptions();
  source = next;
  sourceSubscriptions.push(next.directory.onDirectoryChanged(reconcileAllRows));
  if (next.leases !== null) {
    sourceSubscriptions.push(next.leases.onLeasesChanged(reconcileAllRows));
  }
  // Installing a source IS a change event, so it goes through the same reconciler every other change event does.
  // Reusing `reconcileAllRows` rather than repairing that loop in place is the point: a second copy of "compare, adopt, notify" is what allowed this one to drift from the real one in the first place.
  reconcileAllRows();
}

/**
 * Clears the window's source.
 * The cached per-host answers are nulled here too, but that is belt-and-braces and is stated as such rather than left to read as load-bearing: it is not observable through this module's public surface.
 */
export function resetHostConnectionRegistry(): void {
  disposeSourceSubscriptions();
  source = null;
  for (const record of records.values()) {
    if (record.lingerTimer !== null) {
      clearTimeout(record.lingerTimer);
      record.lingerTimer = null;
    }
    record.entry = null;
    record.lease = null;
  }
  // Records with no subscriber and no holder have nothing left to keep them.
  for (const [hostId, record] of [...records]) {
    if (record.refCount === 0 && record.listeners.size === 0) {
      record.reconnect.dispose();
      records.delete(hostId);
    }
  }
}

/**
 * Test-only: drops subscribers too.
 * Production never wants this - see the StrictMode reasoning on {@link resetHostConnectionRegistry}.
 */
export function resetHostConnectionRegistryForTest(): void {
  resetHostConnectionRegistry();
  for (const record of records.values()) {
    record.reconnect.dispose();
    record.listeners.clear();
  }
  records.clear();
  anyRowListeners.clear();
}

function disposeSourceSubscriptions(): void {
  for (const subscription of sourceSubscriptions) {
    subscription.dispose();
  }
  sourceSubscriptions = [];
}

function readEntry(hostId: string): HostDirectoryEntry | null {
  return source === null ? null : source.directory.findById(hostId);
}

function readLease(hostId: string): HostLeaseSnapshot | null {
  if (source === null || source.leases === null) return null;
  return source.leases.leaseFor(hostId);
}

function reconcileAllRows(): void {
  const changed: HostRecord[] = [];
  for (const record of records.values()) {
    const nextEntry = readEntry(record.hostId);
    const nextLease = readLease(record.hostId);
    if (
      hostDirectoryEntryEquals(record.entry, nextEntry) &&
      hostLeaseSnapshotEquals(record.lease, nextLease)
    ) {
      continue;
    }
    record.entry = nextEntry;
    record.lease = nextLease;
    changed.push(record);
  }
  // Snapshot the listener sets before delivering.
  // A listener that subscribes or unsubscribes during the fan-out (a React consumer re-rendering into a different host is the ordinary case) must not mutate the set being walked.
  for (const record of changed) {
    for (const listener of [...record.listeners]) {
      listener();
    }
  }
  // The coarse arm fires unconditionally, and the asymmetry with the per-host arm above is the whole point rather than an oversight.
  // Per-host suppression is only possible for a host some subscriber named, because a record is what holds the previous row to compare against.
  for (const listener of [...anyRowListeners]) {
    listener();
  }
}

function recordFor(hostId: string): HostRecord {
  const existing = records.get(hostId);
  if (existing !== undefined) {
    if (existing.lingerTimer !== null) {
      clearTimeout(existing.lingerTimer);
      existing.lingerTimer = null;
    }
    return existing;
  }
  const record: HostRecord = {
    hostId,
    refCount: 0,
    lingerTimer: null,
    entry: readEntry(hostId),
    lease: readLease(hostId),
    reconnect: createHostReconnectEngine(),
    listeners: new Set(),
  };
  records.set(hostId, record);
  return record;
}

function releaseRecord(record: HostRecord): void {
  if (record.refCount > 0 || record.listeners.size > 0) {
    return;
  }
  if (record.lingerTimer !== null) {
    return;
  }
  record.lingerTimer = setTimeout(() => {
    record.lingerTimer = null;
    if (record.refCount > 0 || record.listeners.size > 0) {
      return;
    }
    if (records.get(record.hostId) === record) {
      record.reconnect.dispose();
      records.delete(record.hostId);
    }
  }, HOST_CONNECTION_LINGER_MS);
}

/**
 * Subscribes to one host's row/lease transitions: a consumer that can name its host is woken when that host's row or lease moves, and told nothing when any other host's does.
 * Contrast {@link subscribeAnyHostRowChanged}, which wakes unconditionally because its callers cannot name their host - the row not existing yet is the thing they are waiting on.
 */
export function subscribeHostRowChanged(
  hostId: string,
  listener: () => void,
): () => void {
  const record = recordFor(hostId);
  record.listeners.add(listener);
  return () => {
    record.listeners.delete(listener);
    releaseRecord(record);
  };
}

/**
 * Subscribes to "some host's row or lease moved", for consumers that resolve their own host id at read time and so cannot name it at subscribe time (`useReactiveHostReadiness` reads the id off the client it was handed).
 * Deliberately separate from {@link subscribeHostRowChanged} rather than the same call with a wildcard: a per-host subscriber being woken by an unrelated host is the defect this split exists to make impossible.
 */
export function subscribeAnyHostRowChanged(listener: () => void): () => void {
  anyRowListeners.add(listener);
  return () => {
    anyRowListeners.delete(listener);
  };
}

/**
 * Takes a ref-counted, keep-warm hold on one host's connection (§1).
 * The returned view's `release()` drops this consumer's reference; the host's bookkeeping lingers for {@link HOST_CONNECTION_LINGER_MS} after the last one, and a re-acquire inside that window adopts it warm.
 */
export function acquireHostConnection(hostId: string): HostConnectionLease {
  const record = recordFor(hostId);
  record.refCount += 1;
  let released = false;
  return {
    hostId,
    reconnect: record.reconnect,
    status: () => readLease(hostId),
    entry: () => readEntry(hostId),
    onChanged: (listener) => subscribeHostRowChanged(hostId, listener),
    release: () => {
      if (released) return;
      released = true;
      record.refCount -= 1;
      releaseRecord(record);
    },
  };
}

export function hostConnectionRefCountForTest(hostId: string): number {
  return records.get(hostId)?.refCount ?? 0;
}

export function hostDirectoryEntryEquals(
  a: HostDirectoryEntry | null,
  b: HostDirectoryEntry | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.hostId === b.hostId &&
    a.label === b.label &&
    a.kind === b.kind &&
    a.websocketUrl === b.websocketUrl &&
    a.version === b.version &&
    // The derived verdict, not the coarse bit - consumers render the reason, and `indeterminate` -> confirmed `offline` leaves the coarse bit at `not-dialable` on both sides.
    hostUnavailability(a) === hostUnavailability(b) &&
    // The recovery-dial window (F7): recomputed from `lastSeenAt` recency at every projection, so an `offline` row whose only change is aging past the 4h fuse cap flips this while every other compared field stays identical.
    isRelayFuseRecoveryCandidate(a) === isRelayFuseRecoveryCandidate(b) &&
    // Not part of the base shape (R-1): a same-host public-key rotation leaves every base field byte-identical, and session registries key their durable owners on it.
    // A host with a populated cache and nobody holding it is exactly the case this module cannot see.
    remotePublicKeyOf(a) === remotePublicKeyOf(b)
  );
}

function remotePublicKeyOf(entry: HostDirectoryEntry): string | null {
  return isRemoteHostDirectoryEntry(entry) ? entry.publicKey : null;
}

export function hostLeaseSnapshotEquals(
  a: HostLeaseSnapshot | null,
  b: HostLeaseSnapshot | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return leaseEquals(a, b);
}
