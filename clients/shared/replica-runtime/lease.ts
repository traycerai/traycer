/**
 * Refcounted demand on a resource that costs something to hold materialised.
 *
 * Two resources need this today and they are the same shape: an artifact body
 * doc (expensive as a live CRDT, cheap as encoded bytes) and a warm session
 * (an open websocket plus a loaded snapshot). Both are currently governed by
 * hand-rolled counters in separate files.
 *
 * The interface is ASYNC on materialise, and that is the whole reason it exists
 * as a named seam rather than as a counter. Today `acquireArtifactBodyLease` is
 * synchronous because the cold bytes sit in the same closure as the caller.
 * Once the cold tier moves into a worker, materialising means transferring
 * bytes across a thread boundary - so the lease call has to be able to return a
 * promise BEFORE anything moves, or every call site becomes a breaking change
 * at the worst possible moment.
 *
 * The one constraint that cannot move: a doc bound by an editor stays on the
 * main thread. Tiptap/y-prosemirror binds `Y.Doc` / `XmlFragment` / `Awareness`
 * by reference, synchronously. The lease is exactly that boundary.
 */
import type { RuntimeEnvironment } from "./runtime-environment";

/** A held lease. Releasing is idempotent; dropping the reference is a leak. */
export interface LeaseHandle {
  readonly resourceId: string;
  release(): void;
  /** True once {@link release} has run. */
  isReleased(): boolean;
}

export type LeaseGrant<TResource> =
  | {
      readonly kind: "granted";
      readonly resource: TResource;
      readonly lease: LeaseHandle;
    }
  /**
   * There is nothing to materialise for this id.
   *
   * NOT an error, and NOT an empty resource. The distinction is load-bearing:
   * a room reports `"ready"` on first observation independently of any bytes
   * arriving, so there is a real window in which the resource is ready and no
   * bytes exist anywhere. Fabricating an empty doc there hands the caller a
   * live-but-EMPTY body that reads as a real, empty one - export writes an
   * empty file past its "still loading" guard, and an editor binds a blank
   * document. An empty resource and an unseeded resource must stay
   * distinguishable, so this arm returns no lease at all.
   */
  | { readonly kind: "unseeded" }
  /** The registry is disposed, or acquisition was cancelled. */
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * Turns a resource id into a live resource, and back.
 *
 * Supplied per plane. The registry owns counting, cooldown, and the cap; the
 * materializer owns what those words mean for its resource - which for the
 * artifact-room tier is `Y.mergeUpdates` in and `Y.encodeStateAsUpdate` out,
 * arithmetic the runtime deliberately does not know about.
 */
export interface LeaseMaterializer<TResource> {
  /**
   * `null` means unseeded - see {@link LeaseGrant}. Rejecting is for genuine
   * failures only.
   */
  materialize(resourceId: string): Promise<TResource | null>;

  /**
   * Return the resource to its cheap representation. Called on cooldown expiry
   * and on cap eviction, never while a lease is held.
   *
   * Must be deterministic and complete: this is where every observer, provider
   * and undo manager attached to the resource is destroyed. A demote that
   * leaves a listener attached is a leak that survives every subsequent
   * materialise/demote cycle.
   */
  demote(resourceId: string, resource: TResource): void;
}

export interface LeasePolicy {
  /**
   * How long a resource stays materialised after its last lease is dropped.
   *
   * The linger is the reclaim mechanism, not the cap. Remounts are common - tab
   * switches, canvas virtualisation, a re-render that swaps the editor - and
   * re-materialising costs a full decode, so an immediate demote trades memory
   * for visible latency.
   */
  readonly cooldownMs: number;
  /**
   * Backstop ceiling on simultaneously materialised resources, so a
   * pathological set cannot hold an unbounded number live INSIDE the linger
   * window.
   *
   * Set well above a realistic working set on purpose. The recorded tuning
   * history on the artifact-room tier is explicit: at 8 it evicted on ordinary
   * scrolling, so every scroll-in paid a full encode of the evicted body and
   * every scroll-back paid a compaction plus a decode of its own - churn that
   * cost more than the memory it reclaimed. Treat a low value here as a
   * regression, not a tightening.
   */
  readonly maxMaterialized: number;
}

export interface LeaseRegistry<TResource> {
  /**
   * Take a lease, materialising if needed.
   *
   * The count is incremented BEFORE materialisation completes, so a resource
   * cannot be cooled by a concurrent release while it is being brought up.
   */
  acquire(resourceId: string): Promise<LeaseGrant<TResource>>;

  /**
   * Read an ALREADY materialised resource without taking a lease or affecting
   * recency.
   *
   * `null` covers both "cold" and "unknown" and the caller must not distinguish
   * them - a reader that materialises on peek is how a passive projection ends
   * up pinning the whole working set.
   */
  peek(resourceId: string): TResource | null;

  /** Outstanding leases on a resource. A leased resource is never cooled. */
  leaseCount(resourceId: string): number;

  /** Ids currently materialised. For telemetry and the memory accountant. */
  materializedIds(): readonly string[];

  /**
   * Demote everything demotable right now, ignoring cooldowns. Leased
   * resources are skipped - a cap or a budget may never revoke a lease, because
   * the holder is an editor with a live binding.
   */
  demoteIdle(): void;

  /**
   * Terminal: cancels every cooldown, demotes everything including leased
   * resources, and fails subsequent acquisitions. Held leases become
   * `isReleased()` immediately.
   */
  dispose(): void;
}

/**
 * Everything a lease registry needs to exist. Grouped so the construction site
 * reads as a policy decision rather than as an argument list.
 */
export interface LeaseRegistryOptions<TResource> {
  readonly environment: RuntimeEnvironment;
  readonly materializer: LeaseMaterializer<TResource>;
  readonly policy: LeasePolicy;
}
