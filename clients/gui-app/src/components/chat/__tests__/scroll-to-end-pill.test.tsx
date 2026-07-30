import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScrollToEndPillState } from "@/components/chat/chat-scroll-to-end-pill-state";
import { ScrollToEndPill } from "@/components/chat/scroll-to-end-pill";

afterEach(() => {
  cleanup();
});

function renderPill(state: ScrollToEndPillState) {
  const onClick = vi.fn();
  const result = render(
    <ScrollToEndPill state={state} onClick={onClick} bottomOffsetPx={84} />,
  );
  return { ...result, onClick };
}

describe("ScrollToEndPill", () => {
  it("keeps aria-label 'Scroll to end' across plain, streaming, new-reply, and hidden", () => {
    const states: ReadonlyArray<ScrollToEndPillState> = [
      { kind: "plain" },
      { kind: "streaming", workingVerb: "Cogitating" },
      { kind: "new-reply" },
      { kind: "hidden" },
    ];

    for (const state of states) {
      const { unmount } = renderPill(state);
      expect(
        screen.getByRole("button", { name: "Scroll to end", hidden: true }),
      ).toBeTruthy();
      unmount();
    }
  });

  it("renders AgentSpinningDots + working-verb text in the streaming state", () => {
    renderPill({ kind: "streaming", workingVerb: "Noodling" });

    expect(screen.getByTestId("scroll-to-end-pill-spinner")).toBeTruthy();
    expect(screen.getByText("Noodling…")).toBeTruthy();
  });

  it("renders 'New reply' text in the new-reply state (no spinner)", () => {
    renderPill({ kind: "new-reply" });

    expect(screen.getByText("New reply")).toBeTruthy();
    expect(screen.queryByTestId("scroll-to-end-pill-spinner")).toBeNull();
  });

  it("hides interaction when hidden (tabIndex -1, opacity-0, pointer-events-none)", () => {
    renderPill({ kind: "hidden" });

    const pill = screen.getByRole("button", {
      name: "Scroll to end",
      hidden: true,
    });
    expect(pill.tabIndex).toBe(-1);
    expect(pill.classList.contains("opacity-0")).toBe(true);
    expect(pill.classList.contains("pointer-events-none")).toBe(true);
  });
});
