export interface BoundsStreamFlush {
  readonly windowMs: number;
  readonly received: number;
  readonly applied: number;
  readonly coalesced: number;
  readonly rejected: number;
  readonly maxDeltaPx: number | null;
}

export interface BoundsStreamStats {
  recordApplied(maxDeltaPx: number | null): void;
  recordCoalesced(): void;
  recordRejected(): void;
  drain(windowMs: number): BoundsStreamFlush | null;
}

export function createBoundsStreamStats(): BoundsStreamStats {
  let received = 0;
  let applied = 0;
  let coalesced = 0;
  let rejected = 0;
  let maxDeltaPx: number | null = null;

  return {
    recordApplied(delta) {
      received += 1;
      applied += 1;
      if (delta !== null && (maxDeltaPx === null || delta > maxDeltaPx)) {
        maxDeltaPx = delta;
      }
    },
    recordCoalesced() {
      received += 1;
      coalesced += 1;
    },
    recordRejected() {
      received += 1;
      rejected += 1;
    },
    drain(windowMs) {
      if (received === 0) return null;
      const flush: BoundsStreamFlush = {
        windowMs,
        received,
        applied,
        coalesced,
        rejected,
        maxDeltaPx,
      };
      received = 0;
      applied = 0;
      coalesced = 0;
      rejected = 0;
      maxDeltaPx = null;
      return flush;
    },
  };
}
