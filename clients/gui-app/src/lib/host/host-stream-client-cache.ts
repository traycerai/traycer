import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";

/**
 * Share one stream client per identity; subscription registries key on `instanceId`.
 * This cache's refcount is the only lifetime owner; evict immediately at zero (no linger).
 */

// Matches the separator convention in `transport-key.ts` and `active-remote-sessions.ts`: a NUL cannot appear in any of these field values, so distinct identities can never collide onto one key.
const KEY_SEPARATOR = "\u0000";

/** Close reason; keep stable so operator greps still match. */
const TEARDOWN_REASON = "transient-host-client-teardown";

/**
 * Cache key must be at least as fine as every value the built client captures.
 * Omits the revalidator object, HostClient, and RequestContext - those would make the cache inert or rebuild on token refresh.
 */
export interface HostStreamClientIdentity {
  /** `local` / `remote` / `mock` - a different transport implementation. */
  readonly kind: string;
  readonly hostId: string;
  readonly userId: string;
  /** Captured by the local branch's endpoint provider at build time. */
  readonly websocketUrl: string;
  /** The remote host's static key; `""` for a non-remote target. */
  readonly publicKey: string;
  /** Captured by the remote branch's attach-grant provider. */
  readonly authnBaseUrl: string;
  /** `auth === null` is a deliberate one-shot and never shares. */
  readonly authRecovery: "revalidate" | "terminal";
}

/**
 * One consumer's hold on a cached client.
 * `client` is the SHARED object itself, not a per-consumer view - handing back a wrapper would give each consumer its own `instanceId` and defeat the entire point.
 */
export interface HostStreamClientLease {
  readonly client: IHostStreamClient<HostStreamRpcRegistry>;
  /** Takes one more reference on this entry. Pairs with {@link release}. */
  readonly retain: () => void;
  /** Returns one reference. A return this lease never borrowed is ignored. */
  readonly release: () => void;
}

interface CacheEntry {
  readonly client: IHostStreamClient<HostStreamRpcRegistry>;
  refCount: number;
}

const entriesByKey = new Map<string, CacheEntry>();

export function hostStreamClientCacheKey(
  identity: HostStreamClientIdentity,
): string {
  return [
    identity.kind,
    identity.hostId,
    identity.userId,
    identity.websocketUrl,
    identity.publicKey,
    identity.authnBaseUrl,
    identity.authRecovery,
  ].join(KEY_SEPARATOR);
}

/**
 * The live client for `identity`, taking one reference on it.
 * `createClient` runs at most once per cache miss and never on a hit; it returns `null` for a target that cannot be built (a malformed remote row), and that degrades to `null` here without caching the failure.
 */
export function acquireHostStreamClient(
  identity: HostStreamClientIdentity,
  createClient: () => IHostStreamClient<HostStreamRpcRegistry> | null,
): HostStreamClientLease | null {
  const key = hostStreamClientCacheKey(identity);
  const existing = entriesByKey.get(key);
  if (existing !== undefined && existing.client.isClosed()) {
    entriesByKey.delete(key);
  }
  let entry = entriesByKey.get(key);
  if (entry === undefined) {
    const client = createClient();
    if (client === null) {
      return null;
    }
    entry = { client, refCount: 0 };
    entriesByKey.set(key, entry);
  }
  // Captured, never re-looked-up by key.
  // A late `release` from a holder of an entry that has since been evicted (closed, then rebuilt under the same identity) must decrement the entry IT took, or it would drain the successor's count and close a client other surfaces are still reading.
  const captured = entry;
  captured.refCount += 1;
  let borrowed = 1;
  return {
    client: captured.client,
    retain: () => {
      borrowed += 1;
      captured.refCount += 1;
    },
    release: () => {
      if (borrowed === 0) {
        return;
      }
      borrowed -= 1;
      captured.refCount -= 1;
      if (captured.refCount > 0) {
        return;
      }
      // Only drop the map slot if it still points at THIS entry - an evicted
      // entry's slot may already hold its successor.
      if (entriesByKey.get(key) === captured) {
        entriesByKey.delete(key);
      }
      captured.client.close(TEARDOWN_REASON);
    },
  };
}

/** Test-only: live references held for `identity`. */
export function hostStreamClientRefCountForTest(
  identity: HostStreamClientIdentity,
): number {
  return entriesByKey.get(hostStreamClientCacheKey(identity))?.refCount ?? 0;
}

/**
 * Test-only: drops every entry WITHOUT closing its client.
 * Suites share this module, and a suite that left an entry behind would otherwise hand the next one a client built against its fixtures.
 */
export function resetHostStreamClientCacheForTest(): void {
  entriesByKey.clear();
}
