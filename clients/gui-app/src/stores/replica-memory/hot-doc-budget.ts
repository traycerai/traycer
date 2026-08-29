import type {
  BudgetHolderId,
  EvictionOutcome,
  MemoryAccountant,
  ProtectedBytes,
} from "@traycer-clients/shared/replica-runtime";
import { BUDGET_PLANE_IDS } from "@traycer-clients/shared/replica-runtime";

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
  demoteColdestUnpinned(overBytes: number): EvictionOutcome;
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
  return `${hostId}:${epicId}:${runtimeToken}:${artifactRoomId}`;
}

export function createHotDocBudgetBook(): HotDocBudgetBook {
  const tiers = new Map<string, HotDocBudgetTier>();

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
      for (const tier of tiers.values()) {
        if (remaining <= 0) break;
        const outcome = tier.demoteColdestUnpinned(remaining);
        reclaimed += outcome.reclaimedBytes;
        remaining -= outcome.reclaimedBytes;
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
