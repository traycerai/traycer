import { useRef } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OnboardingCoachmark } from "@/components/onboarding/onboarding-coachmark";

function CoachmarkHarness() {
  const rootRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={rootRef} data-testid="guide-root">
      <OnboardingCoachmark
        id="lifecycle-guide"
        title="Guide title"
        content="Guide content"
        progress={null}
        rootRef={rootRef}
        selector='[data-testid="guide-target"]'
        onClose={() => undefined}
        onTarget={null}
        back={null}
        action={null}
      />
    </div>
  );
}

function createVisibleTarget(): HTMLButtonElement {
  const target = document.createElement("button");
  target.setAttribute("data-testid", "guide-target");
  Object.defineProperty(target, "getClientRects", {
    configurable: true,
    value: () => ({ length: 1 }),
  });
  return target;
}

describe("OnboardingCoachmark lifecycle", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("does not measure a target after it is replaced before Joyride's deferred update", async () => {
    render(<CoachmarkHarness />);
    const root = screen.getByTestId("guide-root");
    const target = createVisibleTarget();
    root.append(target);

    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Guide title" })).toBeTruthy(),
    );

    const replacement = createVisibleTarget();
    vi.useFakeTimers();

    act(() => {
      window.dispatchEvent(new Event("resize"));
      target.replaceWith(replacement);
      vi.advanceTimersByTime(100);
    });
    vi.useRealTimers();

    await waitFor(() => {
      expect(root.querySelector('[data-testid="guide-target"]')).toBe(
        replacement,
      );
      expect(screen.getByRole("dialog", { name: "Guide title" })).toBeTruthy();
    });
    expect(replacement.hasAttribute("data-first-task-highlight")).toBe(false);
  });
});
