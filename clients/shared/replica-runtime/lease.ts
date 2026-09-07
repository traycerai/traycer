/**
 * Refcounted demand on a resource that costs something to hold materialised.
 * The interface is async on materialise, and that is the whole reason it exists as a named seam rather than as a counter.
 */
import type { RuntimeEnvironment } from "./runtime-environment";

/** A held lease. Releasing is idempotent; dropping the reference is a leak. */
export interface LeaseHandle {
  readonly resourceId: string;
  release(): void;
  /** True once {@link release} has run. */
  isReleased(): boolean;
}

/**
 * The result of asking for a lease.
 * The order that makes this load-bearing is the normal one, not an edge case: a room reports ready independently of any bytes arriving, an editor mounts and takes its lease, and only the next snapshot brings content.
 */
export type LeaseGrant<TResource> =
  | {
      readonly kind: "granted";
      readonly lease: LeaseHandle;
      readonly resource: TResource;
    }
  /**
   * Demand is registered; there is nothing to materialise yet.
   * An absent resource and an empty one must stay distinguishable.
   */
  | { readonly kind: "awaiting-seed"; readonly lease: LeaseHandle }
  /**
   * No lease, because no demand was registered: the registry is disposed, or
   * acquisition was cancelled. The only arm a caller has nothing to release.
   */
  | { readonly kind: "unavailable"; readonly reason: string };

export interface LeaseMaterializer<TResource> {
  /**
   * `null` means "nothing to materialise yet" and produces an `"awaiting-seed"` grant - see {@link LeaseGrant}.
   * It is a normal answer, not a failure, and must never be an empty resource.
   */
  materialize(resourceId: string): Promise<TResource | null>;

  /**
   * Return the resource to its cheap representation.
   * Called on cooldown expiry and on cap eviction, never while a lease is held.
   */
  demote(resourceId: string, resource: TResource): void;
}

export interface LeasePolicy {
  /**
   * How long a resource stays materialised after its last lease is dropped.
   * The linger is the reclaim mechanism, not the cap.
   */
  readonly cooldownMs: number;
  /**
   * Backstop ceiling on simultaneously materialised resources, so a pathological set cannot hold an unbounded number live inside the linger window.
   * Treat a low value here as a regression, not a tightening.
   */
  readonly maxMaterialized: number;
}

export interface LeaseRegistry<TResource> {
  /**
   * Take a lease, materialising if needed.
   * The count is incremented before materialisation completes, so a resource cannot be cooled by a concurrent release while it is being brought up.
   */
  acquire(resourceId: string): Promise<LeaseGrant<TResource>>;

  /**
   * Read an already materialised resource without taking a lease or affecting recency.
   * `null` covers both "cold" and "unknown" and the caller must not distinguish them - a reader that materialises on peek is how a passive projection ends up pinning the whole working set.
   */
  peek(resourceId: string): TResource | null;

  /**
   * Outstanding leases on a resource.
   * A leased resource is never cooled.
   */
  leaseCount(resourceId: string): number;

  /**
   * Ids currently materialised.
   * Do not use this to answer "is anyone holding this"; that is {@link leaseCount}.
   */
  materializedIds(): readonly string[];

  /**
   * Demote everything demotable right now, ignoring cooldowns.
   * Leased resources are skipped - a cap or a budget may never revoke a lease, because the holder is an editor with a live binding.
   */
  demoteIdle(): void;

  /**
   * Terminal: cancels every cooldown, demotes everything including leased resources, and fails subsequent acquisitions.
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
