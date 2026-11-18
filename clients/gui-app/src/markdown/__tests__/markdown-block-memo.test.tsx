import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ComponentType, ReactNode } from "react";
import { TraycerMarkdown } from "@/markdown/traycer-markdown";

// Count renders of a product-level component instead of mocking
// `react-markdown`. Tailmark loads react-markdown from its package graph;
// component overrides still re-run only when MarkdownBlock does not bail.

type HeadingProps = {
  readonly children?: ReactNode;
};

let headingRenders: string[] = [];

function headingText(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") {
    return String(children);
  }
  if (Array.isArray(children)) {
    return children.map(headingText).join("");
  }
  return "";
}

const CountingH2: ComponentType<HeadingProps> = ({ children }) => {
  headingRenders.push(headingText(children));
  return <h2>{children}</h2>;
};

const countingComponents: Record<
  string,
  ComponentType<Record<string, unknown>>
> = {
  h2: CountingH2 as ComponentType<Record<string, unknown>>,
};

afterEach(() => {
  headingRenders = [];
});

function StreamHarness({ content }: { content: string }) {
  return (
    <TraycerMarkdown
      className={null}
      proseSize="normal"
      components={countingComponents}
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
  it("does NOT re-run settled-block components when a later block grows", () => {
    // Two closed blocks + an open tail. The first heading is settled (a stable
    // blank-line boundary follows it), so growing the tail must not re-render it.
    const settled = "## Title\n\nFirst paragraph is done.\n\n";
    const { rerender } = render(<StreamHarness content={`${settled}Tail`} />);

    const baseline = headingRenders.filter((text) =>
      text.includes("Title"),
    ).length;
    expect(baseline).toBe(1);

    headingRenders = [];
    // Stream more text into ONLY the tail block.
    rerender(
      <StreamHarness content={`${settled}Tail growing more and more`} />,
    );

    const settledRerenders = headingRenders.filter((text) =>
      text.includes("Title"),
    ).length;
    // EXPECTATION: the settled heading block's memo bails -> 0 re-renders.
    expect(settledRerenders).toBe(0);
  });

  it("renders a settled heading a bounded number of times across a streaming sequence", () => {
    const full =
      "## Summary\n\nHere is the plan.\n\n- one\n- two\n\nClosing thoughts here.";
    // Stream by re-rendering with a growing prefix (the real store-driven path).
    const { rerender } = render(<StreamHarness content={full.slice(0, 4)} />);
    const frames = Math.ceil(full.length / 4);
    for (let i = 2; i <= frames; i += 1) {
      rerender(<StreamHarness content={full.slice(0, i * 4)} />);
    }
    // "## Summary" re-renders only while its own bytes are still arriving;
    // once a blank-line boundary settles it, the memo bails. A failing memo
    // would push this toward `frames` (~17). Bounded by the settle point.
    const summaryRenders = headingRenders.filter((text) =>
      text.includes("Summary"),
    ).length;
    expect(summaryRenders).toBeGreaterThanOrEqual(1);
    expect(summaryRenders).toBeLessThanOrEqual(5);
  });
});
