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
 * What the artifact-room tier calls at encode boundaries. One object - `settleCold` is a second
 * method on this sink, not a second sink.
 */
export interface HotDocBudgetSink {
  settle(artifactRoomId: string, bytes: number): void;
  settleCold(artifactRoomId: string, bytes: number): void;
  chargeProvisional(artifactRoomId: string, bytes: number): void;
  release(artifactRoomId: string): void;
}

/**
 * One epic's artifact-room tier, as the hot-docs plane sees it. The book never invents an LRU:
 * `demoteColdestUnpinned` is the tier's own eviction (the same walk `enforceHotCap` already uses).
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
   * Where the next `evict` pass starts its walk. Needed BECAUSE of the deferred-bytes fix above, not
   * independently of it.
   */
  let nextStartIndex = 0;

  /** Every attached tier, beginning at the rotating cursor and wrapping. */
  function* tiersFromRotatingStart(): Generator<HotDocBudgetTier> {
    const ordered = [...tiers.values()];
    if (ordered.length === 0) return;
    // Read before yielding anything, so a `detach` during the walk cannot make
    // the cursor skip a tier on the NEXT pass.
    const start = nextStartIndex % ordered.length;
    nextStartIndex = (start + 1) % ordered.length;
    // Rotated in place rather than indexed with a guard: the modulo is always in range by
    // construction, and a `!== undefined` check on it is dead code this repo's
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
