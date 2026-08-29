import type {
  BudgetHolderId,
  EvictionOutcome,
  MemoryAccountant,
  ProtectedBytes,
} from "@traycer-clients/shared/replica-runtime";
import { BUDGET_PLANE_IDS } from "@traycer-clients/shared/replica-runtime";

/**
 * What the artifact-room tier calls at encode boundaries. One object, three
 * methods — `settleCold` is a second method on this sink, not a second sink.
 *
 * `release` uncharges the HOT holder only. `settleCold(id, 0)` uncharges the
 * cold holder (`0` means gone).
 */
export interface HotDocBudgetSink {
  settle(artifactRoomId: string, bytes: number): void;
  settleCold(artifactRoomId: string, bytes: number): void;
  release(artifactRoomId: string): void;
}

/**
 * One epic's artifact-room tier, as the hot-docs plane sees it.
 *
 * The book never invents an LRU: `demoteColdestUnpinned` is the tier's own
 * eviction (the same walk `enforceHotCap` already uses). Bytes for `measure`
 * come from the book's last-settled figures, not a tier getter.
 */
export interface HotDocBudgetTier {
  readonly epicId: string;
  materializedIds(): readonly string[];
  leaseCount(artifactRoomId: string): number;
  /**
   * Demote the coldest unpinned rooms until `overBytes` is reclaimed or
   * nothing demotable remains. Pinned rooms are reported as protected
   * `"leased"`.
   */
  demoteColdestUnpinned(overBytes: number): EvictionOutcome;
}

export interface HotDocHolderMeasure {
  readonly holderId: BudgetHolderId;
  readonly bytes: number;
  readonly pinned: boolean;
}

export interface HotDocBudgetBook {
  attach(tier: HotDocBudgetTier): void;
  detach(epicId: string): void;
  settle(
    accountant: MemoryAccountant,
    holderId: BudgetHolderId,
    bytes: number,
  ): void;
  release(accountant: MemoryAccountant, holderId: BudgetHolderId): void;
  lastSettledBytes(holderId: BudgetHolderId): number;
  evict(overBytes: number): EvictionOutcome;
  docsResident(): number;
}

export function hotDocHolderId(
  epicId: string,
  artifactRoomId: string,
): BudgetHolderId {
  return `${epicId}:${artifactRoomId}`;
}

export function createHotDocBudgetBook(): HotDocBudgetBook {
  const tiers = new Map<string, HotDocBudgetTier>();
  const lastSettled = new Map<BudgetHolderId, number>();

  return {
    attach(tier: HotDocBudgetTier): void {
      tiers.set(tier.epicId, tier);
    },

    detach(epicId: string): void {
      tiers.delete(epicId);
    },

    settle(
      accountant: MemoryAccountant,
      holderId: BudgetHolderId,
      bytes: number,
    ): void {
      lastSettled.set(holderId, bytes);
      accountant.settle(BUDGET_PLANE_IDS.hotDocs, holderId, bytes);
    },

    release(accountant: MemoryAccountant, holderId: BudgetHolderId): void {
      lastSettled.delete(holderId);
      accountant.release(BUDGET_PLANE_IDS.hotDocs, holderId);
    },

    lastSettledBytes(holderId: BudgetHolderId): number {
      return lastSettled.get(holderId) ?? 0;
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
