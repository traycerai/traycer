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
 *
 * One per window, module-scoped for the same reason the remote session cache
 * is (`host-transport/remote/active-remote-sessions.ts`): the things it
 * answers about - which row a host id resolves to, what the authority says
 * that host's lease is - are per-window facts that non-React owners (session
 * stores, transports) have to reach without a provider in scope. Threading it
 * through React context would also have put a new export on `gui-app`'s
 * `@/lib/host` barrel, which 93 suites mock as a whole module: every one of
 * them would strand on the new name while reading as an unrelated failure.
 *
 * `HostRuntime` installs the source on `start()` and clears it on `dispose()`.
 * With nothing installed every subscription is a no-op and every read answers
 * `null` - a bare harness gets the same answers an unbound client always gave,
 * rather than a throw from a module nobody in that harness wired.
 *
 * WHAT THIS OWNS, and why it is here rather than on `HostClient`:
 *
 *  - **The per-host "row changed" signal.** `HostClient.createRequesterForHostId`
 *    re-reads its row on every property access, so a row that ARRIVES late is
 *    picked up with nothing to re-resolve - but a React consumer still has to
 *    be told to look again. That telling was once `bind()`'s change event; the
 *    active slot it spoke for is gone (P4.2), and this signal is what outlived
 *    it. It is a fact about a HOST (its row moved), not about a privileged
 *    binding, so it belongs to the registry.
 *  - **Lease reads**, projected from the ONE authority the engine publishes -
 *    never a second copy. The registry holds no lease state of its own; it
 *    reads through {@link HostConnectionLeaseSource} so there is exactly one
 *    lease vocabulary in the app.
 *  - **Ref-counted acquisition with a keep-warm linger** for every host kind
 *    (§1). Note what this does NOT do: it does not pool the local host's
 *    per-RPC unary dial. That dial is deliberate structure (P1.3's S1), and
 *    pooling it would change local request isolation - a behavior change this
 *    consolidation is not allowed to make. The generalization is at the LEASE,
 *    which is where §1's ref-count and linger actually live.
 */

/** Where the registry reads directory rows from, and how it hears they moved. */
export interface HostConnectionDirectorySource {
  readonly findById: (hostId: string) => HostDirectoryEntry | null;
  /** The directory's list-wide change event; the registry does the per-host part. */
  readonly onDirectoryChanged: (listener: () => void) => Disposable;
}

/**
 * Where the registry reads LEASES from. Deliberately a port rather than state:
 * the authority engine is the only producer of lease status in this app, and a
 * registry that cached its own copy would be the second status vocabulary the
 * epic exists to delete.
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
 * A consumer's hold on one host's connection. Ref-counted: `release()` drops
 * THIS consumer's reference, and the registry keeps the host warm for
 * {@link HOST_CONNECTION_LINGER_MS} after the last one lets go.
 */
export interface HostConnectionLease {
  readonly hostId: string;
  /** The authority's verdict, or `null` before any lease has been published. */
  readonly status: () => HostLeaseSnapshot | null;
  /** This host's directory row, or `null` while unresolved. */
  readonly entry: () => HostDirectoryEntry | null;
  /** Fires when this host's row or lease moves. */
  readonly onChanged: (listener: () => void) => () => void;
  /**
   * THE reconnect policy for this host (§6). Every stream owner addressing
   * this host reaches its rebuild pacing, reopen lanes and wake episodes
   * through here, so the policy exists once per lease instead of once per
   * owner - which is what "exactly one reconnection policy per transport
   * kind" means operationally.
   */
  readonly reconnect: HostReconnectEngine;
  readonly release: () => void;
}

/**
 * Keep-warm window, matching the remote session cache's own linger
 * (`REMOTE_SESSION_LINGER_MS`). A lease dropping to zero references is a
 * statement about USE, not about the host, so the registry holds the host's
 * per-host bookkeeping for the same window the session underneath it is held -
 * otherwise a panel closing and reopening would rebuild bookkeeping for a
 * connection that never went anywhere.
 */
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
 * Installs the window's source. Called by `HostRuntime.start()`; calling it
 * again replaces the previous wiring (the HMR / re-mount case) without
 * dropping subscribers - they are attached to HOSTS, not to the source.
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
  // Installing a source IS a change event, so it goes through the same
  // reconciler every other change event does.
  //
  // This used to adopt each record's answers in a private loop that
  // deliberately notified nobody, reasoning that "a subscriber that mounted
  // before the source did reads through `useSyncExternalStore`'s own
  // getSnapshot on its next render anyway". That holds only for a subscriber
  // which has never observed anything, and it contradicts the invariant
  // `resetHostConnectionRegistry` states directly below: subscribers
  // deliberately SURVIVE a dispose/reinstall, because dropping them is a
  // StrictMode bug. A survivor HAS observed the previous source's values, and
  // `useSyncExternalStore` does not poll while idle - so with no notification
  // here and no later change from the new source, it keeps the old snapshot
  // indefinitely, and `useReactiveHostReadiness` /
  // `useReactiveOwnerIdentityKey` keep answering for a source that is gone.
  //
  // Reusing `reconcileAllRows` rather than repairing that loop in place is the
  // point: a second copy of "compare, adopt, notify" is what allowed this one
  // to drift from the real one in the first place. It also inherits both rules
  // that copy had lost - structural comparison via
  // `hostDirectoryEntryEquals` / `hostLeaseSnapshotEquals` (the rows are
  // rebuilt per read, so reference equality would report every record as
  // changed), and the UNCONDITIONAL coarse arm, whose own comment records that
  // gating it on `changed.length` reintroduces the P4.2 defect for consumers
  // waiting on a host that has no record yet - which is exactly the state a
  // freshly installed source is in.
  reconcileAllRows();
}

/**
 * Clears the window's SOURCE. Called by `HostRuntime.dispose()`.
 *
 * SUBSCRIBERS ARE DELIBERATELY LEFT ALONE, and this is not an oversight -
 * dropping them is a StrictMode bug. A subscription belongs to the CONSUMER
 * that made it, not to whichever source happened to be installed at the time.
 * React's setup-cleanup-setup double-invoke disposes the runtime and builds a
 * new one while every consumer stays mounted, so a reset that cleared the
 * listener sets would leave those consumers subscribed to nothing, with no
 * event to ever tell them to re-subscribe: the window would run with a live
 * registry that never wakes anybody, which no test asserting "the registry
 * notifies" would catch, because a fresh harness re-subscribes.
 *
 * The records themselves survive to keep their listeners attached.
 *
 * The cached per-host answers are nulled here too, but that is belt-and-braces
 * and is stated as such rather than left to read as load-bearing: it is not
 * observable through this module's public surface. `entry()`/`status()` read
 * through the source rather than the cache, so with no source installed they
 * already answer `null`; and `installHostConnectionRegistrySource` re-adopts
 * every record's answers unconditionally, so the next install resyncs the
 * cache whether or not this cleared it. The thing that actually guarantees
 * freshness after a reinstall is that adopt loop. (Found by the test author
 * for this lane, which could not build a case discriminating the two - the
 * right conclusion being to correct the claim, not to invent a test that
 * appears to prove it.)
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
 * Test-only: drops subscribers too. Suites share this module, so a suite that
 * leaves listeners behind fails the NEXT one in the file. Production never
 * wants this - see the StrictMode reasoning on
 * {@link resetHostConnectionRegistry}.
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

/**
 * Turns the directory's list-wide emit into per-host verdicts.
 *
 * This is the whole reason the registry exists between the directory and its
 * consumers. `findById` allocates a fresh entry object on every read (the
 * local row is rebuilt per snapshot, and on desktop each one crosses the IPC
 * bridge as a new object), so "the directory changed" is true constantly and
 * says nothing about any particular host. Comparing FIELDS per host is what
 * makes the signal mean "this host's row moved" - and doing it once here,
 * rather than in a `useRef` cache inside every consumer, is what stops N
 * consumers of the same host from each re-deriving the same verdict.
 */
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
  // Snapshot the listener sets before delivering. A listener that subscribes
  // or unsubscribes during the fan-out (a React consumer re-rendering into a
  // different host is the ordinary case) must not mutate the set being walked.
  for (const record of changed) {
    for (const listener of [...record.listeners]) {
      listener();
    }
  }
  // THE COARSE ARM FIRES UNCONDITIONALLY, and the asymmetry with the per-host
  // arm above is the whole point rather than an oversight.
  //
  // Per-host suppression is only possible for a host some subscriber NAMED,
  // because a record is what holds the previous row to compare against. The
  // coarse arm exists for consumers that cannot name their host - they read
  // the id off a pinned requester, which answers `null` until the row lands,
  // so the host they are waiting on is exactly the one with no record. Gating
  // this arm on `changed.length` made those consumers unreachable: the row
  // they were waiting for arrived, no record existed for it, nothing was
  // "changed", and the window stayed disabled. That is the P4.2 defect this
  // signal exists to prevent, reproduced inside the mechanism meant to fix it.
  //
  // Firing on every source emit costs nothing observable: every coarse
  // consumer reads through `useSyncExternalStore` with a value-compared
  // snapshot, so a wake that changes no answer renders nothing - which is
  // also exactly how those consumers already behaved on `client.onChange`,
  // an event that likewise fires for reasons unrelated to their own host.
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
    // Re-check at expiry rather than trusting the count captured when the
    // timer was armed: an acquire inside the window adopts this record and
    // cancels the timer, but a subscribe-then-unsubscribe pair can leave the
    // timer armed against a record that is busy again by now.
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
 * Subscribes to ONE host's row/lease transitions: a consumer that can NAME its
 * host is woken when that host's row or lease moves, and told nothing when any
 * other host's does. Its callers are the ones holding a host id already - a
 * directory-entry read, the landing terminal panel's reconciliation, and every
 * lease's own `onChanged`.
 *
 * Contrast {@link subscribeAnyHostRowChanged}, which wakes unconditionally
 * because its callers CANNOT name their host - the row not existing yet is the
 * thing they are waiting on. That is the arm the three reactive projections
 * ride; precision there would mean never waking for the row that matters.
 *
 * Historically this was the per-host replacement for `HostClient.bind()`'s
 * change event, which is why it exists at all - but it no longer needs that
 * comparison to be understood, and the slot has been gone since P4.2.
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
 * Subscribes to "SOME host's row or lease moved", for consumers that resolve
 * their own host id at read time and so cannot name it at subscribe time
 * (`useReactiveHostReadiness` reads the id off the client it was handed).
 * Deliberately separate from {@link subscribeHostRowChanged} rather than the
 * same call with a wildcard: a per-host subscriber being woken by an unrelated
 * host is the defect this split exists to make impossible.
 */
export function subscribeAnyHostRowChanged(listener: () => void): () => void {
  anyRowListeners.add(listener);
  return () => {
    anyRowListeners.delete(listener);
  };
}

/**
 * Takes a ref-counted, keep-warm hold on one host's connection (§1).
 *
 * The returned view's `release()` drops THIS consumer's reference; the host's
 * bookkeeping lingers for {@link HOST_CONNECTION_LINGER_MS} after the last
 * one, and a re-acquire inside that window adopts it warm.
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

/** Test-only: live consumer references held for `hostId`. */
export function hostConnectionRefCountForTest(hostId: string): number {
  return records.get(hostId)?.refCount ?? 0;
}

/**
 * Do these two rows describe the same host state?
 *
 * Lifted out of `gui-app`'s `useHostDirectoryEntry` (where it was a per-hook
 * `useRef` cache) so the registry can answer "did THIS host's row move" once
 * for every consumer. The field list is load-bearing and each entry earned its
 * place; see the hook's own history for the incidents behind the last three.
 */
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
    // The DERIVED verdict, not the coarse bit - consumers render the reason,
    // and `indeterminate` -> confirmed `offline` leaves the coarse bit at
    // `not-dialable` on both sides. Comparing the verdict strictly subsumes
    // the coarse bit (`dialable` <-> `null`).
    hostUnavailability(a) === hostUnavailability(b) &&
    // The recovery-dial window (F7): recomputed from `lastSeenAt` recency at
    // every projection, so an `offline` row whose only change is aging past
    // the 4h fuse cap flips this while every other compared field stays
    // identical.
    isRelayFuseRecoveryCandidate(a) === isRelayFuseRecoveryCandidate(b) &&
    // Not part of the base shape (R-1): a same-host public-key rotation leaves
    // every base field byte-identical, and session registries key their
    // durable owners on it.
    //
    // What this comparison produces is the row-changed SIGNAL: consumers are
    // told to re-read. It is deliberately NOT the query-scope sweep a rebuilt
    // host also needs - that lives in gui-app's `host-key-rotation-sweep`,
    // watching the DIRECTORY, because a record here exists only for a host
    // some consumer named and expires a linger after the last holder lets go.
    // A host with a populated cache and nobody holding it is exactly the case
    // this module cannot see.
    remotePublicKeyOf(a) === remotePublicKeyOf(b)
  );
}

function remotePublicKeyOf(entry: HostDirectoryEntry): string | null {
  return isRemoteHostDirectoryEntry(entry) ? entry.publicKey : null;
}

/**
 * Lease equality for the same suppression purpose. Compared by VALUE because
 * the authority republishes a fresh array (and fresh snapshot objects) on
 * every commit, so reference equality would report a change on every publish
 * whether or not this host moved.
 *
 * Only the null handling lives here - the field-by-field walk is
 * `leaseEquals` in `selection-authority-contract.ts`, whose doc comment
 * flags "TWO READERS AND THEY MUST NOT DIVERGE"; this was a third, hand-rolled
 * copy of that walk before it was routed through the one function.
 */
export function hostLeaseSnapshotEquals(
  a: HostLeaseSnapshot | null,
  b: HostLeaseSnapshot | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return leaseEquals(a, b);
}
