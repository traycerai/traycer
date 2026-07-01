import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReasoningSegment } from "@/components/chat/segments/reasoning-segment";

describe("<ReasoningSegment />", () => {
  afterEach(() => {
    cleanup();
    // The selection-guard test leaves a live range in the shared jsdom window;
    // clear it so a later body-click test isn't silently blocked by it.
    window.getSelection()?.removeAllRanges();
  });

  it("shows the live 'Thinking' label and tail preview while streaming", () => {
    render(
      <ReasoningSegment
        findUnitId={null}
        markdown="Considering the options"
        isStreaming
        durationMs={null}
      />,
    );

    expect(screen.getByText("Thinking")).toBeTruthy();
    // Open by default while streaming, so the tail content is visible.
    expect(screen.getByText("Considering the options")).toBeTruthy();
  });

  it("collapses to a 'Thought for Xs' summary once completed", () => {
    render(
      <ReasoningSegment
        findUnitId={null}
        markdown="Considering the options"
        isStreaming={false}
        durationMs={12000}
      />,
    );

    expect(screen.getByText("Thought for 12s")).toBeTruthy();
    // Collapsed by default once done - the full trace is not rendered.
    expect(screen.queryByText("Considering the options")).toBeNull();
  });

  it("falls back to 'Thought' when no duration is known", () => {
    render(
      <ReasoningSegment
        findUnitId={null}
        markdown="Considering the options"
        isStreaming={false}
        durationMs={null}
      />,
    );

    expect(screen.getByText("Thought")).toBeTruthy();
  });

  it("expands the full trace on click", () => {
    render(
      <ReasoningSegment
        findUnitId={null}
        markdown="Detailed chain of thought"
        isStreaming={false}
        durationMs={3000}
      />,
    );

    expect(screen.queryByText("Detailed chain of thought")).toBeNull();
    fireEvent.click(screen.getByText("Thought for 3s"));
    expect(screen.getByText("Detailed chain of thought")).toBeTruthy();
  });

  it("expands the streaming preview when the block body (not just the chevron) is clicked", () => {
    render(
      <ReasoningSegment
        findUnitId={null}
        markdown="Considering the options"
        isStreaming
        durationMs={null}
      />,
    );

    const header = screen.getByRole("button", { name: "Thinking" });
    expect(header.getAttribute("aria-expanded")).toBe("false");

    // The preview body itself is a click target, not only the header chevron.
    fireEvent.click(screen.getByText("Considering the options"));
    expect(header.getAttribute("aria-expanded")).toBe("true");
  });

  it("collapses again when the expanded trace body is re-clicked", () => {
    render(
      <ReasoningSegment
        findUnitId={null}
        markdown="Detailed chain of thought"
        isStreaming={false}
        durationMs={3000}
      />,
    );

    const header = screen.getByRole("button", { name: "Thought for 3s" });
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(screen.getByText("Detailed chain of thought"));
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  it("does not collapse when the click ends a text selection (click-drag)", () => {
    render(
      <ReasoningSegment
        findUnitId={null}
        markdown="Detailed chain of thought"
        isStreaming={false}
        durationMs={3000}
      />,
    );

    const header = screen.getByRole("button", { name: "Thought for 3s" });
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");

    // Simulate an active (non-collapsed) text selection over the trace.
    const traceText = screen.getByText("Detailed chain of thought");
    const range = document.createRange();
    range.selectNodeContents(traceText);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.click(traceText);
    // Still expanded - the click was the tail of a selection, not a toggle.
    expect(header.getAttribute("aria-expanded")).toBe("true");
  });

  it("still toggles when the active selection is outside the block", () => {
    render(
      <div>
        <p data-testid="outside">unrelated selectable text</p>
        <ReasoningSegment
          findUnitId={null}
          markdown="Detailed chain of thought"
          isStreaming={false}
          durationMs={3000}
        />
      </div>,
    );

    const header = screen.getByRole("button", { name: "Thought for 3s" });
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");

    // Select text OUTSIDE the reasoning block.
    const range = document.createRange();
    range.selectNodeContents(screen.getByTestId("outside"));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    // The stray selection is not inside this block, so the click still collapses.
    fireEvent.click(screen.getByText("Detailed chain of thought"));
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  it("links the header to the body region via aria-controls only when shown", () => {
    render(
      <ReasoningSegment
        findUnitId={null}
        markdown="Detailed chain of thought"
        isStreaming={false}
        durationMs={3000}
      />,
    );

    const header = screen.getByRole("button", { name: "Thought for 3s" });
    expect(header.getAttribute("aria-controls")).toBeNull();

    fireEvent.click(header);
    const controls = header.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    expect(document.getElementById(controls ?? "")).toBeTruthy();
  });

  it("rolls a multi-hour reasoning duration up to 'Xh Ym Zs'", () => {
    render(
      <ReasoningSegment
        findUnitId={null}
        markdown="Considering the options"
        isStreaming={false}
        durationMs={3_661_000}
      />,
    );

    expect(screen.getByText("Thought for 1h 1m 1s")).toBeTruthy();
  });
});
