import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";

/**
 * Get-or-create cache for a host's STREAM CLIENT OBJECT, so two surfaces
 * dialing the same host hold the same `IHostStreamClient` instance.
 *
 * WHAT THIS BUYS, precisely: `instanceId`. The shared-subscription registries
 * (`use-git-list-changed-files-subscription`, `use-workspace-file-list-
 * subscription`, the two PR ones) key their ref-counted entry on
 * `client.instanceId | ...params`, deliberately - a rebuilt client must never
 * be served an entry whose session belongs to a previous, possibly closed one.
 * That key is correct and stays. But it means subscription sharing is decided
 * by CLIENT OBJECT IDENTITY, and every caller of `useHostStreamClientBindingFor`
 * used to mint its own object. Two surfaces pinned to the same host therefore
 * opened two `git.subscribeStatus` sessions against it, and the host ran two
 * watchers, where the app-wide path had always run one.
 *
 * The remote branch shows the shape of the waste: `createRemoteHostTransport`
 * already shares ONE `RemoteSession` per identity (`acquireRemoteSession`), but
 * wraps each acquire in a fresh `new RemoteStreamClient(session)` with a fresh
 * `instanceId` - one mux connection carrying N duplicate subscriptions. The
 * local branch is worse: N `WsStreamClient`s means N websockets.
 *
 * ─── THE COMPOSITION WITH `pin`/`unpin` ───────────────────────────────────
 *
 * EXACTLY ONE REFCOUNT OWNS THE CLIENT'S LIFETIME, and it is this module's.
 *
 * `HostStreamClientBinding` already carried a `pin`/`unpin` pair, implemented
 * as closure state inside the owning hook's effect: it deferred that ONE hook
 * instance's unmount-time `close()` until a cross-hook-lifetime consumer (the
 * image-preview coalescing layer) let go. A module cache with its own count
 * BESIDE that pair would be two lifecycles over one object, which is how the
 * same code produces both premature disposal and a leak in different races.
 *
 * THE OBVIOUS FIX IS THE WRONG ONE, and it was proposed: leave `pin`/`unpin`
 * as the owner and make the cache a lookup that its lifecycle evicts from.
 * That cannot work, and the reason is worth keeping because it is not visible
 * from the pair's own code. `pinCount` STARTS AT ZERO and almost no caller
 * ever pins - it counts cross-hook CONSUMERS, not SHARERS. So under sharing it
 * is zero for the ordinary case, and the first surface's unmount closes the
 * object the second surface is still reading through. Keeping the pair as
 * owner produces precisely the premature disposal the one-refcount invariant
 * exists to prevent.
 *
 * So the pair is not kept beside this count - it is EXPRESSED IN it. `pin` is
 * `retain` and `unpin` is `release` on the entry this consumer acquired, and
 * the hook's own effect holds exactly one reference of the same kind, taken at
 * build and returned at cleanup. `unmountedWhilePinned` is gone: the ordering
 * it encoded falls out of the count.
 *
 *   pin, unmount, unpin  ->  2, 1, 0 -> closes AT THE UNPIN, as documented.
 *   unmount, no pin      ->  1, 0    -> closes at unmount, as before.
 *   pin, unpin, mounted  ->  2, 1    -> no close, as before.
 *
 * `HostStreamClientBinding.pin`'s contract is therefore preserved word for
 * word - "the underlying close defers until the pin count reaches zero" is now
 * a statement about this count rather than a closure's, and it holds across
 * consumers instead of within one.
 *
 * `Lease.borrowed` is NOT a second refcount and must not grow into one. It
 * counts what THIS lease borrowed, so an over-`unpin` (the asset layer's
 * `unpin` is reachable from two paths, guarded today only by a map-identity
 * check at the call site) cannot return a reference this lease never took and
 * close the object under a different surface. It is the same role as the
 * `released` boolean on `acquireRemoteSession`'s per-consumer view: a guard on
 * the borrower, never a decider about the object.
 *
 * ─── WHAT EVICTS AN ENTRY, AND WHEN ───────────────────────────────────────
 *
 * refCount reaching zero, immediately. NO KEEP-WARM LINGER, unlike the
 * `(hostId, userId)` remote-session cache this otherwise models itself on, and
 * that difference is deliberate:
 *
 *   - The expensive half already lingers ONE LAYER DOWN. A remote client's
 *     cost is the attach-grant mint, the relay dial and the Noise handshake -
 *     all owned by `acquireRemoteSession`, whose keep-warm window survives
 *     this object's disposal. A prompt re-acquire still adopts a warm, already
 *     attached session and rebuilds only the cheap wrapper. A second linger
 *     over that would keep the WRAPPER warm, which costs a `new` to recreate.
 *   - Immediate close is EXACTLY what the owning hook did before this cache
 *     existed, so this change moves WHO holds the object without moving WHEN
 *     it dies. A host with one consumer behaves identically before and after;
 *     only the multi-consumer case changes, and only in the intended
 *     direction. That is a much smaller claim to have to defend than a new
 *     timer would be.
 *
 * DECLARED GAP, so nobody has to rediscover it: a HANDOFF within a single
 * commit - surface A unmounts as surface B mounts on the same host - closes
 * and re-dials, because React runs every cleanup before any effect. That is
 * also what happens today (the two never shared an object at all), so it is an
 * unfixed cost rather than a regression, and a linger is what would fix it.
 * Anyone adding one must first re-derive the identity below: a lingering entry
 * has NO consumer vouching for it, which is precisely the condition
 * `RemoteSessionIdentity.authEpoch` exists for and which cannot arise here.
 */

// Matches the separator convention in `transport-key.ts` and
// `active-remote-sessions.ts`: a NUL cannot appear in any of these field
// values, so distinct identities can never collide onto one key.
const KEY_SEPARATOR = "\u0000";

/**
 * The reason a cache-evicted client is closed with. Unchanged from when the
 * owning hook closed its own client inline, so log lines and any operator
 * grep for it keep matching.
 */
const TEARDOWN_REASON = "transient-host-client-teardown";

/**
 * Everything that decides whether two consumers may hold the SAME stream
 * client. The rule this is derived from, which is stronger than "what feels
 * like identity":
 *
 *   THE KEY MUST BE AT LEAST AS FINE AS EVERY VALUE THE BUILT CLIENT CAPTURES.
 *
 * A field the client closes over but the key omits is a cache hit that hands
 * back a client wired to the old value. `websocketUrl` is the example that
 * makes it concrete: the local branch's `endpoint: () => endpoint` captures
 * the endpoint fixed at build time, so a host respawning on a new URL MUST
 * miss - even though `remoteAwareOwnerIdentity` deliberately omits the URL for
 * local hosts (it answers a different question: whether a long-lived OWNER
 * should be replaced, where a URL move is healed by re-dial instead).
 *
 * Three things are deliberately ABSENT, and each is absent for a reason that
 * would not survive being guessed at:
 *
 *   - THE `StreamAuthRevalidator` OBJECT. Only its POLICY is here
 *     (`authRecovery`), exactly as `RemoteSessionIdentity.authRecovery` keys
 *     the session cache below, and for the same reason: every production
 *     revalidator is `createStreamAuthRevalidator(authService)` over the one
 *     app-wide auth service, so two of them funnel into the same single-flight
 *     recovery. Keying on the object would not merely be conservative here, it
 *     would make this cache INERT: `useStreamAuthRevalidator` memoizes PER
 *     HOOK INSTANCE, so two surfaces are guaranteed two distinct revalidator
 *     objects wrapping one service - i.e. the multi-surface case this exists
 *     for is exactly the case that would never share. (Its own doc says
 *     "referentially stable for a given `AuthService`", which is true within
 *     one component and false across two.) `terminal` (`auth: null`, the
 *     side-effecting one-shot) stays unshareable in both directions, which is
 *     the distinction that actually carries risk.
 *   - THE `HostClient` THE BEARER CLOSES OVER. `useHostClient()` hands each
 *     component its own requester proxy, so this is per-CONSUMER, not per
 *     identity - keying on it would make the cache inert the same way. Sound
 *     because the bearer is a LIVE READ of spine state
 *     (`getRequestContext()?.credentials`) and every requester proxies one
 *     spine: whichever consumer's proxy happened to build the entry, all of
 *     them read the same answer.
 *   - THE `RequestContext` OBJECT (an "auth epoch"). Same live-read argument,
 *     and this layer has already ruled on it: a context swap for the same user
 *     must NOT rebuild the client, or every token refresh would close the
 *     active chat socket. A DIFFERENT user is separated by `userId` below.
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
 * One consumer's hold on a cached client. `client` is the SHARED object
 * itself, not a per-consumer view - handing back a wrapper would give each
 * consumer its own `instanceId` and defeat the entire point.
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
 * The live client for `identity`, taking one reference on it. `createClient`
 * runs at most once per cache miss and never on a hit; it returns `null` for a
 * target that cannot be built (a malformed remote row), and that degrades to
 * `null` here without caching the failure.
 *
 * A CLOSED entry is evicted rather than adopted, mirroring
 * `acquireRemoteSession`: a terminally closed client can never carry traffic
 * again, and its holders each re-acquire through their own `onClosed` rebuild.
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
  // Captured, never re-looked-up by key. A late `release` from a holder of an
  // entry that has since been evicted (closed, then rebuilt under the same
  // identity) must decrement the entry IT took, or it would drain the
  // successor's count and close a client other surfaces are still reading.
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
 * Test-only: drops every entry WITHOUT closing its client. Suites share this
 * module, and a suite that left an entry behind would otherwise hand the next
 * one a client built against its fixtures.
 */
export function resetHostStreamClientCacheForTest(): void {
  entriesByKey.clear();
}
