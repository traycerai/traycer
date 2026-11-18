import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CompactionSegment } from "@/components/chat/segments/compaction-segment";
import {
  mappedCompactionSegment,
  persistedCompaction,
  REFUSED_COMPACTION_ERROR as REFUSED,
  type CompactionSegmentValue,
} from "./rendered-compaction-fixture";

/**
 * A compaction block decoded by the live schema, carried through the real
 * rendered-message mapper and drawn by the real segment component: the
 * `notApplied` outcome must reach the screen as a neutral label with no
 * destructive reason line, while a plain failure, a completed compaction and an
 * in-flight one keep theirs.
 */

function drawn(segment: CompactionSegmentValue) {
  return render(
    <CompactionSegment
      status={segment.status}
      notApplied={segment.notApplied}
      trigger={segment.trigger}
      preTokens={segment.preTokens}
      postTokens={segment.postTokens}
      durationMs={segment.durationMs}
      summary={segment.summary}
      error={segment.error}
      findUnitId={null}
    />,
  );
}

describe("a decoded compaction block through the rendered-message mapper and the segment", () => {
  afterEach(() => {
    cleanup();
  });

  it("draws a not-applied manual compaction neutrally, with no reason line, metrics or expander", () => {
    const segment = mappedCompactionSegment(
      persistedCompaction({ notApplied: true }),
    );
    expect(segment.notApplied).toBe(true);
    expect(segment.status).toBe("errored");

    drawn(segment);

    expect(screen.getByText("Compaction not applied")).toBeDefined();
    expect(screen.queryByText("Compaction failed")).toBeNull();
    expect(screen.queryByText(REFUSED)).toBeNull();
    expect(screen.queryByText(/tokens/)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("draws a not-applied automatic compaction with the automatic label", () => {
    const segment = mappedCompactionSegment(
      persistedCompaction({ notApplied: true, trigger: "auto" }),
    );

    drawn(segment);

    expect(screen.getByText("Auto-compaction not applied")).toBeDefined();
    expect(screen.queryByText("Auto-compaction failed")).toBeNull();
    expect(screen.queryByText(REFUSED)).toBeNull();
  });

  it("keeps the failure label and reason line for an errored row with no flag", () => {
    const segment = mappedCompactionSegment(persistedCompaction({}));
    expect(segment.notApplied).toBe(false);

    drawn(segment);

    expect(screen.getByText("Compaction failed")).toBeDefined();
    expect(screen.queryByText("Compaction not applied")).toBeNull();
    expect(screen.getByText(REFUSED)).toBeDefined();
  });

  it("keeps the failure label for an explicit false flag", () => {
    const segment = mappedCompactionSegment(
      persistedCompaction({ notApplied: false }),
    );

    drawn(segment);

    expect(screen.getByText("Compaction failed")).toBeDefined();
    expect(screen.getByText(REFUSED)).toBeDefined();
  });

  it("keeps a completed compaction's metrics and summary expander", () => {
    const segment = mappedCompactionSegment(
      persistedCompaction({
        status: "completed",
        trigger: "manual",
        preTokens: 120000,
        postTokens: 30000,
        durationMs: 85000,
        summary: "The folded context",
        error: null,
      }),
    );
    expect(segment.notApplied).toBe(false);

    drawn(segment);

    expect(screen.getByText("Compacted")).toBeDefined();
    expect(screen.getByText(/→ .* tokens · 1m 25s/)).toBeDefined();
    expect(screen.getByRole("button")).toBeDefined();
  });

  it("keeps the live label for a compaction still in flight", () => {
    const segment = mappedCompactionSegment(
      persistedCompaction({
        status: "streaming",
        trigger: "auto",
        preTokens: 120000,
        error: null,
      }),
    );
    expect(segment.notApplied).toBe(false);

    drawn(segment);

    expect(screen.getByText("Auto-compacting…")).toBeDefined();
  });
});
