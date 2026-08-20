import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { usePressStartActivation } from "@/lib/host/press-start-activation";

/**
 * The half of `usePressStartActivation` that jsdom CAN see.
 *
 * jsdom has no input pipeline: it dispatches whatever event you name, so it
 * cannot reproduce the defect this hook exists for (a press whose element is
 * removed before release, which emits no click in a real browser). That case
 * belongs to `scripts/boot-escape-hatch-press-browser.mjs` and is asserted
 * there against real Chromium input.
 *
 * What is testable here is the ACTIVATION ALGEBRA - which combinations of
 * events must produce exactly one call, and which must produce none. Those
 * are decisions this hook makes in plain JavaScript, and pinning them here
 * keeps the browser gate focused on the one thing only it can answer.
 */
function Probe(props: { readonly onActivate: () => void }) {
  const activation = usePressStartActivation(props.onActivate);
  return (
    <button type="button" {...activation} data-testid="probe">
      Open settings
    </button>
  );
}

function renderProbe(): { readonly activate: Mock<() => void> } {
  const activate = vi.fn<() => void>();
  render(<Probe onActivate={activate} />);
  return { activate };
}

afterEach(() => {
  cleanup();
});

describe("usePressStartActivation", () => {
  it("fires once for a primary press followed by its click", () => {
    // The ordinary case, and the one a double-fire would break: the pointer
    // press activates, and the click the browser derives from it must not
    // activate a second time.
    const { activate } = renderProbe();
    const button = screen.getByTestId("probe");

    fireEvent.pointerDown(button, { button: 0, isPrimary: true });
    fireEvent.click(button, { detail: 1 });

    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("fires on the press alone, without any click", () => {
    // The whole point: in a real browser this is what a press across a surface
    // swap looks like - press, no click, ever.
    const { activate } = renderProbe();

    fireEvent.pointerDown(screen.getByTestId("probe"), {
      button: 0,
      isPrimary: true,
    });

    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("fires for keyboard activation, which arrives as a click with detail 0", () => {
    // Enter/Space on a focused button, a screen reader's activation and a
    // programmatic `.click()` all arrive this way, with no pointer press
    // behind them. Press-start activation must not cost the keyboard path.
    const { activate } = renderProbe();

    fireEvent.click(screen.getByTestId("probe"), { detail: 0 });

    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("ignores a secondary-button press", () => {
    const { activate } = renderProbe();

    fireEvent.pointerDown(screen.getByTestId("probe"), {
      button: 2,
      isPrimary: true,
    });

    expect(activate).not.toHaveBeenCalled();
  });

  it("ignores a non-primary pointer", () => {
    // A second touch point in a multi-touch gesture is not an activation.
    const { activate } = renderProbe();

    fireEvent.pointerDown(screen.getByTestId("probe"), {
      button: 0,
      isPrimary: false,
    });

    expect(activate).not.toHaveBeenCalled();
  });
});
