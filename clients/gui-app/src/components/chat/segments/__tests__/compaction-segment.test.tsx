import "../../../../../__tests__/test-browser-apis";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CompactionSegment } from "../compaction-segment";

describe("<CompactionSegment />", () => {
  afterEach(() => {
    cleanup();
  });

  it("reports a completed compaction with its before/after metrics", () => {
    render(
      <CompactionSegment
        status="completed"
        trigger="manual"
        preTokens={120000}
        postTokens={30000}
        durationMs={85000}
        summary={null}
        error={null}
        findUnitId={null}
      />,
    );

    expect(screen.getByText("Compacted")).toBeDefined();
    // Token grouping is locale-dependent, so match the shape, not the digits.
    expect(screen.getByText(/→ .* tokens · 1m 25s/)).toBeDefined();
  });

  // The failure this guards: a compaction that died mid-flight (provider 529,
  // for instance) used to render the success bar, so the transcript claimed the
  // context had been folded when it had not.
  it("says a failed compaction failed instead of claiming success", () => {
    render(
      <CompactionSegment
        status="errored"
        trigger="manual"
        preTokens={120000}
        postTokens={null}
        durationMs={null}
        summary={null}
        error="Error during compaction: API Error: 529 Overloaded."
        findUnitId={null}
      />,
    );

    expect(screen.getByText("Compaction failed")).toBeDefined();
    expect(screen.queryByText("Compacted")).toBeNull();
    expect(
      screen.getByText("Error during compaction: API Error: 529 Overloaded."),
    ).toBeDefined();
  });

  it("names an automatic compaction's failure as automatic", () => {
    render(
      <CompactionSegment
        status="errored"
        trigger="auto"
        preTokens={null}
        postTokens={null}
        durationMs={null}
        summary={null}
        error="Compaction failed"
        findUnitId={null}
      />,
    );

    expect(screen.getByText("Auto-compaction failed")).toBeDefined();
  });

  // A stale summary carried over from the started event is not a result, so a
  // failed bar must not offer it for expansion.
  it("offers no summary expander on a failed compaction", () => {
    render(
      <CompactionSegment
        status="errored"
        trigger="manual"
        preTokens={null}
        postTokens={null}
        durationMs={null}
        summary="Half-written summary"
        error="Compaction failed"
        findUnitId={null}
      />,
    );

    expect(screen.queryByRole("button")).toBeNull();
  });
});
