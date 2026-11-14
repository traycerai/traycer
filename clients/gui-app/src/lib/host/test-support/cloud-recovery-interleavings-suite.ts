import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  describeFailures,
  explore,
  passFor,
  type PassKind,
  type RetryPolicy,
  type Slice,
  type Variant,
} from "@/lib/host/test-support/cloud-recovery-interleavings";
import { HeldTimers } from "@/lib/host/test-support/held-timers";
import { appLogger } from "@/lib/logger";

/** Holds TanStack's timers for the file's tests and restores them after; returns them. */
export function holdTimersForFile(): HeldTimers {
  const timers = new HeldTimers();
  beforeAll(() => {
    vi.spyOn(appLogger, "warn").mockImplementation(() => undefined);
    timers.install();
  });
  afterAll(() => {
    timers.restore();
    vi.restoreAllMocks();
  });
  return timers;
}

/**
 * Registers the walk of the sweep's events for the stranded reads of
 * `variants`, under `retry`, over the named passes. A file runs one slice of
 * the walk, so each stays inside the per-file time budget.
 */
export function describeInterleavings(slice: {
  readonly retry: RetryPolicy;
  readonly variants: readonly Variant[];
  readonly passes: readonly PassKind[];
  readonly slice: Slice;
}): void {
  const title =
    slice.retry === "app"
      ? "under the app's retry policy"
      : "with every try one attempt";
  const part = slice.slice === "all" ? "" : `, first event ${slice.slice}`;

  describe(`sweepTransientCloudFailures over every ordering of its events, ${title}${part}`, () => {
    const timers = holdTimersForFile();

    it.each(slice.variants)(
      "keeps every invariant for a stranded read that $label",
      async (variant) => {
        const report: string[] = [];
        for (const kind of slice.passes) {
          const counts = await explore(
            { variant, retry: slice.retry, timers },
            passFor(kind, slice.retry, slice.slice),
          );
          report.push(describeFailures(counts));
        }

        expect(report.join("")).toBe("");
      },
      120_000,
    );
  });
}
