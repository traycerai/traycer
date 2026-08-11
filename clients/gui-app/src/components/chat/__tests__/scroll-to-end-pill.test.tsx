import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
      { kind: "streaming" },
      { kind: "new-reply" },
      { kind: "hidden" },
    ];

    for (const state of states) {
      const { unmount } = renderPill(state);
      const pill =
        state.kind === "hidden"
          ? screen.getByRole<HTMLButtonElement>("button", { hidden: true })
          : screen.getByRole<HTMLButtonElement>("button", {
              name: "Scroll to end",
            });
      expect(pill.getAttribute("aria-label")).toBe("Scroll to end");
      unmount();
    }
  });

  it("renders only the three-dot wave in the streaming state", () => {
    renderPill({ kind: "streaming" });
    const pill = screen.getByRole<HTMLButtonElement>("button", {
      name: "Scroll to end",
    });

    expect(
      screen.getByTestId("scroll-to-end-pill-streaming-dots"),
    ).toBeTruthy();
    expect(pill.textContent).toBe("");
  });

  it("renders only the down arrow for new replies", () => {
    renderPill({ kind: "new-reply" });
    const pill = screen.getByRole<HTMLButtonElement>("button", {
      name: "Scroll to end",
    });

    expect(pill.querySelector("svg.lucide-arrow-down")).toBeTruthy();
    expect(pill.textContent).toBe("");
    expect(
      screen.queryByTestId("scroll-to-end-pill-streaming-dots"),
    ).toBeNull();
  });

  it("uses a compact circle and animates its presence", () => {
    renderPill({ kind: "plain" });
    const pill = screen.getByRole<HTMLButtonElement>("button", {
      name: "Scroll to end",
    });

    expect(pill.classList.contains("size-8")).toBe(true);
    expect(pill.classList.contains("scale-100")).toBe(true);
    expect(pill.classList.contains("opacity-100")).toBe(true);
  });

  it("hides interaction when hidden (tabIndex -1, opacity-0, pointer-events-none)", () => {
    const { onClick } = renderPill({ kind: "hidden" });

    const pill = screen.getByRole<HTMLButtonElement>("button", {
      hidden: true,
    });
    expect(pill.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByRole("button", { name: "Scroll to end" })).toBeNull();
    expect(pill.tabIndex).toBe(-1);
    expect(pill.classList.contains("opacity-0")).toBe(true);
    expect(pill.classList.contains("pointer-events-none")).toBe(true);
    fireEvent.click(pill);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("moves focus away before invoking the visible pill's activation handler", () => {
    const { onClick } = renderPill({ kind: "plain" });
    const pill = screen.getByRole("button", { name: "Scroll to end" });
    pill.focus();
    expect(document.activeElement).toBe(pill);

    fireEvent.click(pill);

    expect(document.activeElement).not.toBe(pill);
    expect(onClick).toHaveBeenCalledOnce();
  });
});
