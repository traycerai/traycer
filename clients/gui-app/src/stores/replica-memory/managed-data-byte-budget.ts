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
      let before = inputs.readAccountedBytes();
      if (before === null || before <= inputs.readLimitBytes()) {
        blockedAtBytes = null;
        return;
      }
      // An unchanged over-protected plateau is not another eviction request.
      if (blockedAtBytes !== null && before === blockedAtBytes) return;
      pruning = true;
      try {
        let prunedThisPass = false;
        // One pass may release several warm sessions. Every step must
        // actually lower the account before another is considered; an async
        // worker disposal is never credited as freed bytes in advance.
        while (before > inputs.readLimitBytes()) {
          const evicted = inputs.evictOldestChat() || inputs.evictOldestTask();
          if (!evicted) {
            blockedAtBytes = before;
            return;
          }
          if (!prunedThisPass) {
            prunes += 1;
            prunedThisPass = true;
          }
          const after = inputs.readAccountedBytes();
          if (after === null || after >= before) {
            blockedAtBytes = before;
            return;
          }
          before = after;
        }
        blockedAtBytes = null;
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
