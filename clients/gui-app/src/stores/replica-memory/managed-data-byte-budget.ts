/**
 * One global managed-data prune after a burst of completed settlements.
 * Count-cap eligibility remains authoritative for both session kinds.
 */
export interface ManagedDataByteBudgetInputs {
  readonly readAccountedBytes: () => number | null;
  readonly readLimitBytes: () => number;
  readonly evictOldestChat: () => boolean;
  readonly evictOldestTask: () => boolean;
  readonly scheduleMicrotask: (callback: () => void) => void;
}

export interface ManagedDataByteBudget {
  noteSettlement(): void;
  noteEligibilityChange(): void;
  snapshot(): {
    readonly prunes: number;
    readonly overProtected: boolean;
  };
}

export function createManagedDataByteBudget(
  inputs: ManagedDataByteBudgetInputs,
): ManagedDataByteBudget {
  let queued = false;
  let pruning = false;
  let blockedAtBytes: number | null = null;
  let prunes = 0;

  const queuePrune = (): void => {
    if (queued || pruning) return;
    queued = true;
    inputs.scheduleMicrotask(() => {
      queued = false;
      const before = inputs.readAccountedBytes();
      if (before === null || before <= inputs.readLimitBytes()) {
        blockedAtBytes = null;
        return;
      }
      // An unchanged over-protected plateau is not another eviction request.
      if (blockedAtBytes !== null && before <= blockedAtBytes) return;
      pruning = true;
      try {
        const evicted = inputs.evictOldestChat() || inputs.evictOldestTask();
        if (evicted) prunes += 1;
        const after = inputs.readAccountedBytes();
        blockedAtBytes =
          !evicted || after === null || after >= before ? before : null;
      } finally {
        pruning = false;
      }
    });
  };

  return {
    noteSettlement: queuePrune,
    noteEligibilityChange(): void {
      blockedAtBytes = null;
      queuePrune();
    },
    snapshot: () => ({ prunes, overProtected: blockedAtBytes !== null }),
  };
}
