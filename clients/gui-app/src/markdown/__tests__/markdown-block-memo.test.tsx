import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Replace react-markdown with a render-counter. Each render of a `<Markdown>`
// (i.e. each NON-bailed MarkdownBlock) bumps the counter keyed on its `raw`
// children, so we can tell whether a SETTLED block re-runs react-markdown as
// later tokens stream into a different block.
const markdownRenders: string[] = [];
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => {
    markdownRenders.push(children);
    return <div data-md>{children}</div>;
  },
}));

import { TraycerMarkdown } from "@/markdown/traycer-markdown";

afterEach(() => {
  markdownRenders.length = 0;
});

function StreamHarness({ content }: { content: string }) {
  return (
    <TraycerMarkdown
      className={null}
      proseSize="normal"
      components={null}
      remarkPlugins={null}
      rehypePlugins={null}
      quotable={false}
      isStreaming
    >
      {content}
    </TraycerMarkdown>
  );
}

describe("MarkdownBlock memo bail during streaming", () => {
  it("does NOT re-run react-markdown for a settled block when a later block grows", () => {
    // Two closed blocks + an open tail. The first heading is settled (a stable
    // blank-line boundary follows it), so growing the tail must not re-render it.
    const settled = "## Title\n\nFirst paragraph is done.\n\n";
    const { rerender } = render(<StreamHarness content={`${settled}Tail`} />);

    const baseline = markdownRenders.filter((raw) =>
      raw.startsWith("## Title"),
    ).length;
    expect(baseline).toBe(1);

    markdownRenders.length = 0;
    // Stream more text into ONLY the tail block.
    rerender(
      <StreamHarness content={`${settled}Tail growing more and more`} />,
    );

    const settledRerenders = markdownRenders.filter((raw) =>
      raw.startsWith("## Title"),
    ).length;
    // EXPECTATION: the settled heading block's memo bails -> 0 re-renders.
    expect(settledRerenders).toBe(0);
  });

  it("renders a settled block a bounded number of times across a streaming sequence", () => {
    const full =
      "## Summary\n\nHere is the plan.\n\n- one\n- two\n\nClosing thoughts here.";
    // Stream by re-rendering with a growing prefix (the real store-driven path).
    const { rerender } = render(<StreamHarness content={full.slice(0, 4)} />);
    const frames = Math.ceil(full.length / 4);
    for (let i = 2; i <= frames; i += 1) {
      rerender(<StreamHarness content={full.slice(0, i * 4)} />);
    }
    // The "## Summary" heading re-renders only while its own bytes are still
    // arriving; once a blank-line boundary settles it, the memo bails. A failing
    // memo would push this toward `frames` (~17). Bounded by the settle point.
    const summaryRenders = markdownRenders.filter((raw) =>
      raw.startsWith("## Summary"),
    ).length;
    expect(summaryRenders).toBeGreaterThanOrEqual(1);
    expect(summaryRenders).toBeLessThanOrEqual(5);
  });
});
