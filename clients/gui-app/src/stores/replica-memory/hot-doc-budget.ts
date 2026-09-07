import type {
  BudgetHolderId,
  EvictionOutcome,
  MemoryAccountant,
  ProtectedBytes,
} from "@traycer-clients/shared/replica-runtime";
import {
  BUDGET_PLANE_IDS,
  sessionKeyOf,
} from "@traycer-clients/shared/replica-runtime";
import type { HotDocEvictionOutcome } from "@/stores/epics/open-epic/runtime/epic-runtime-accounting-port";

/**
 * What the artifact-room tier calls at encode boundaries. One object —
 * `settleCold` is a second method on this sink, not a second sink.
 *
 * `release` uncharges the HOT holder only. `settleCold(id, 0)` uncharges the
 * cold holder (`0` means gone). `chargeProvisional` is the hot-path estimate
 * between encode settles.
 */
export interface HotDocBudgetSink {
  settle(artifactRoomId: string, bytes: number): void;
  settleCold(artifactRoomId: string, bytes: number): void;
  chargeProvisional(artifactRoomId: string, bytes: number): void;
  release(artifactRoomId: string): void;
}

/**
 * One epic's artifact-room tier, as the hot-docs plane sees it.
 *
 * The book never invents an LRU: `demoteColdestUnpinned` is the tier's own
 * eviction (the same walk `enforceHotCap` already uses). `key` is the
 * host-scoped runtime token, so a cross-host re-point cannot detach the
 * winner.
 */
export interface HotDocBudgetTier {
  readonly key: string;
  materializedIds(): readonly string[];
  demoteColdestUnpinned(overBytes: number): HotDocEvictionOutcome;
}

export interface HotDocBudgetBook {
  attach(tier: HotDocBudgetTier): void;
  detach(key: string): void;
  settle(
    accountant: MemoryAccountant,
    holderId: BudgetHolderId,
    bytes: number,
  ): void;
  chargeProvisional(
    accountant: MemoryAccountant,
    holderId: BudgetHolderId,
    bytes: number,
  ): void;
  release(accountant: MemoryAccountant, holderId: BudgetHolderId): void;
  evict(overBytes: number): EvictionOutcome;
  docsResident(): number;
}

export function hotDocHolderId(
  hostId: string,
  epicId: string,
  runtimeToken: string,
  artifactRoomId: string,
): BudgetHolderId {
  return sessionKeyOf([hostId, epicId, runtimeToken, artifactRoomId]);
}

export function createHotDocBudgetBook(): HotDocBudgetBook {
  const tiers = new Map<string, HotDocBudgetTier>();
  /**
   * Where the next `evict` pass starts its walk.
   *
   * Needed BECAUSE of the deferred-bytes fix above, not independently of it.
   * Bounding a pass's total ask means one tier can now absorb the whole
   * overage, and with a fixed insertion-ordered walk that would always be the
   * same tier - so an epic whose documents are all pinned would answer every
   * pass, dispatch a demotion that frees nothing, and the later epics holding
   * genuinely cold documents would never be reached. The plane would sit over
   * budget forever, which is a worse failure than the over-eviction being
   * fixed: that one wasted work, this one stops reclaiming.
   *
   * Advanced once per pass rather than per tier, so a single pass still walks
   * every tier in order and only the STARTING point moves.
   */
  let nextStartIndex = 0;

  /**
   * Every attached tier, beginning at the rotating cursor and wrapping.
   *
   * A generator so the walk is lazy: the loop below breaks as soon as the ask
   * is covered, and the common case (one epic, or an overage the first tier
   * absorbs) touches nothing else.
   */
  function* tiersFromRotatingStart(): Generator<HotDocBudgetTier> {
    const ordered = [...tiers.values()];
    if (ordered.length === 0) return;
    // Read before yielding anything, so a `detach` during the walk cannot make
    // the cursor skip a tier on the NEXT pass.
    const start = nextStartIndex % ordered.length;
    nextStartIndex = (start + 1) % ordered.length;
    // Rotated in place rather than indexed with a guard: the modulo is always
    // in range by construction, and a `!== undefined` check on it is dead code
    // this repo's `no-unnecessary-condition` rejects.
    yield* ordered.slice(start);
    yield* ordered.slice(0, start);
  }

  return {
    attach(tier: HotDocBudgetTier): void {
      tiers.set(tier.key, tier);
    },

    detach(key: string): void {
      tiers.delete(key);
    },

    settle(
      accountant: MemoryAccountant,
      holderId: BudgetHolderId,
      bytes: number,
    ): void {
      accountant.settle(BUDGET_PLANE_IDS.hotDocs, holderId, bytes);
    },

    chargeProvisional(
      accountant: MemoryAccountant,
      holderId: BudgetHolderId,
      bytes: number,
    ): void {
      accountant.chargeProvisional(BUDGET_PLANE_IDS.hotDocs, holderId, bytes);
    },

    release(accountant: MemoryAccountant, holderId: BudgetHolderId): void {
      accountant.release(BUDGET_PLANE_IDS.hotDocs, holderId);
    },

    evict(overBytes: number): EvictionOutcome {
      let remaining = overBytes;
      let reclaimed = 0;
      const protectedBytesByKind = new Map<ProtectedBytes["kind"], number>();
      for (const tier of tiersFromRotatingStart()) {
        if (remaining <= 0) break;
        const outcome = tier.demoteColdestUnpinned(remaining);
        reclaimed += outcome.reclaimedBytes;
        // DEFERRED BYTES COUNT AGAINST THE ASK, never against the recovery.
        // A worker-backed tier answers `reclaimedBytes: 0` for a demotion it
        // has accepted and dispatched, so subtracting only what was reclaimed
        // left `remaining` at the full overage and handed the same debt to the
        // next epic - a 1 MiB overage across five open epics dispatched 1 MiB
        // of demotion five times over, evicting warm documents that were never
        // needed and paying to re-encode and rematerialize them.
        //
        // They are NOT added to `reclaimed`: the outcome this returns is what
        // the accountant uses to decide whether the plane is still over, and
        // reporting a promise as a recovery would make it stop asking on the
        // strength of bytes that have not been freed.
        remaining -= outcome.reclaimedBytes + outcome.deferredBytes;
        for (const entry of outcome.protectedBytesByKind) {
          protectedBytesByKind.set(
            entry.kind,
            (protectedBytesByKind.get(entry.kind) ?? 0) + entry.bytes,
          );
        }
      }
      return {
        reclaimedBytes: reclaimed,
        protectedBytesByKind: [...protectedBytesByKind.entries()].map(
          ([kind, bytes]) => ({ kind, bytes }),
        ),
      };
    },

    docsResident(): number {
      let count = 0;
      for (const tier of tiers.values()) {
        count += tier.materializedIds().length;
      }
      return count;
    },
  };
}
