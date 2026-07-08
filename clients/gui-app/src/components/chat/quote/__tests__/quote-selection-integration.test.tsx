import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useRef, type RefObject } from "react";

import { TooltipProvider } from "@/components/ui/tooltip";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";

import { QuoteSelectionPopover } from "../quote-selection-popover";
import { useQuoteSelection } from "../use-quote-selection";

// These tests isolate the stale-snapshot behaviour, not viewport clipping, so
// they use no transcript boundary (first-line anchoring, never clipped).
const NULL_BOUNDARY: RefObject<HTMLElement | null> = { current: null };

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
  useComposerDraftStore.setState({ drafts: {} });
  vi.restoreAllMocks();
});

function nonZeroRect(): DOMRect {
  return {
    x: 10,
    y: 20,
    width: 120,
    height: 18,
    top: 20,
    left: 10,
    right: 130,
    bottom: 38,
    toJSON: () => ({}),
  };
}

function flushFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

/** Mirrors the real ChatMessages wiring: the hook bound to a transcript
 *  container, the popover rendered when a snapshot exists. */
function QuoteHarness(props: { readonly enabled: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { snapshot, dismiss } = useQuoteSelection({
    containerRef,
    enabled: props.enabled,
  });
  return (
    <TooltipProvider>
      <div ref={containerRef} data-testid="transcript">
        <div data-quotable="true">
          <p>Quotable assistant text.</p>
        </div>
      </div>
      {snapshot !== null ? (
        <QuoteSelectionPopover
          taskId="task-1"
          snapshot={snapshot}
          onDismiss={dismiss}
          boundaryRef={NULL_BOUNDARY}
        />
      ) : null}
    </TooltipProvider>
  );
}

function quoteButton(): HTMLElement | null {
  return screen.queryByRole("button", { name: "Quote" });
}

async function dragSelectParagraph(): Promise<void> {
  const paragraph = screen.getByText("Quotable assistant text.");
  const range = document.createRange();
  range.selectNodeContents(paragraph);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  const transcript = screen.getByTestId("transcript");
  await act(async () => {
    transcript.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await flushFrame();
  });
}

describe("quote selection - stale snapshot across the setting toggle", () => {
  it("off -> collapse selection -> on does not resurface the popover", async () => {
    // jsdom has no layout, so give every range a paintable rect; otherwise the
    // popover's anchor guard would dismiss for the wrong reason.
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(
      nonZeroRect(),
    );

    const { rerender } = render(<QuoteHarness enabled />);
    await dragSelectParagraph();
    expect(quoteButton()).not.toBeNull();

    // Toggle the setting OFF: the affordance disappears immediately.
    rerender(<QuoteHarness enabled={false} />);
    expect(quoteButton()).toBeNull();

    // Mutate the selection while disabled (no selectionchange listener runs).
    window.getSelection()?.removeAllRanges();

    // Toggle back ON: the snapshot is stale, so the popover must NOT reappear.
    // rerender flushes the popover's layout-effect reposition, whose liveness
    // guard dismisses synchronously before paint.
    rerender(<QuoteHarness enabled />);
    expect(quoteButton()).toBeNull();
  });

  it("off -> keep the selection -> on still shows the popover", async () => {
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(
      nonZeroRect(),
    );

    const { rerender } = render(<QuoteHarness enabled />);
    await dragSelectParagraph();
    expect(quoteButton()).not.toBeNull();

    rerender(<QuoteHarness enabled={false} />);
    expect(quoteButton()).toBeNull();

    // Selection is left intact this time.
    rerender(<QuoteHarness enabled />);
    expect(quoteButton()).not.toBeNull();
  });
});
