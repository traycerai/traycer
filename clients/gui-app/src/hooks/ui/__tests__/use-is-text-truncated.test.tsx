import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { useIsTextTruncated } from "@/hooks/ui/use-is-text-truncated";

function TruncationProbe(props: { readonly content: string }): ReactNode {
  const { ref, isTruncated } = useIsTextTruncated<HTMLSpanElement>(
    props.content,
  );
  return (
    <div>
      <span ref={ref} data-testid="probe-text">
        {props.content}
      </span>
      <span data-testid="probe-flag">{isTruncated ? "yes" : "no"}</span>
    </div>
  );
}

function stubTextMetrics(input: {
  readonly scrollWidth: number;
  readonly clientWidth: number;
}): () => void {
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.getAttribute("data-testid") === "probe-text") {
        return input.scrollWidth;
      }
      return 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.getAttribute("data-testid") === "probe-text") {
        return input.clientWidth;
      }
      return 0;
    },
  });
  return () => {
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get: () => 0,
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => 0,
    });
  };
}

describe("useIsTextTruncated", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("reports truncated when scrollWidth exceeds clientWidth", () => {
    const restore = stubTextMetrics({ scrollWidth: 240, clientWidth: 100 });
    render(<TruncationProbe content="A long title that overflows" />);
    expect(screen.getByTestId("probe-flag").textContent).toBe("yes");
    restore();
  });

  it("reports not truncated when the text fits", () => {
    const restore = stubTextMetrics({ scrollWidth: 80, clientWidth: 100 });
    render(<TruncationProbe content="Short" />);
    expect(screen.getByTestId("probe-flag").textContent).toBe("no");
    restore();
  });

  it("re-measures when content changes", () => {
    const restore = stubTextMetrics({ scrollWidth: 80, clientWidth: 100 });
    const { rerender } = render(<TruncationProbe content="Short" />);
    expect(screen.getByTestId("probe-flag").textContent).toBe("no");
    restore();

    const restoreOverflow = stubTextMetrics({
      scrollWidth: 300,
      clientWidth: 100,
    });
    act(() => {
      rerender(
        <TruncationProbe content="Now this title is long enough to overflow" />,
      );
    });
    expect(screen.getByTestId("probe-flag").textContent).toBe("yes");
    restoreOverflow();
  });
});
