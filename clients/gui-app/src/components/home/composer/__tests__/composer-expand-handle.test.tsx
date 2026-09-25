import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

import { ComposerExpandHandle } from "../composer-expand-handle";

afterEach(cleanup);

/**
 * jsdom does not implement `setPointerCapture` on `HTMLElement`, and the
 * handle calls it unconditionally on pointer down, so every test needs the
 * stub in place before dispatching pointer events.
 */
beforeEach(() => {
  HTMLElement.prototype.setPointerCapture = vi.fn();
});

/** A minimal stateful wrapper so a real toggle drives `aria-expanded`. */
function ControlledHandle({
  initialExpanded,
}: {
  readonly initialExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(initialExpanded);
  return (
    <ComposerExpandHandle expanded={expanded} onExpandedChange={setExpanded} />
  );
}

function getHandle(): HTMLElement {
  return screen.getByRole("button", { name: /composer/i });
}

describe("ComposerExpandHandle", () => {
  it("expands on a pull up past the threshold, once, even if the move continues", () => {
    const onExpandedChange = vi.fn();
    render(
      <ComposerExpandHandle
        expanded={false}
        onExpandedChange={onExpandedChange}
      />,
    );
    const handle = getHandle();

    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 76, pointerId: 1 });
    expect(onExpandedChange).toHaveBeenCalledTimes(1);
    expect(onExpandedChange).toHaveBeenCalledWith(true);

    // Continuing to travel further up must not fire it again.
    fireEvent.pointerMove(handle, { clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 40, pointerId: 1 });
    expect(onExpandedChange).toHaveBeenCalledTimes(1);
  });

  it("collapses on a pull down past the threshold while expanded", () => {
    const onExpandedChange = vi.fn();
    render(
      <ComposerExpandHandle expanded onExpandedChange={onExpandedChange} />,
    );
    const handle = getHandle();

    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 124, pointerId: 1 });
    expect(onExpandedChange).toHaveBeenCalledTimes(1);
    expect(onExpandedChange).toHaveBeenCalledWith(false);

    fireEvent.pointerMove(handle, { clientY: 160, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 160, pointerId: 1 });
    expect(onExpandedChange).toHaveBeenCalledTimes(1);
  });

  it("toggles on a short move that stays under the threshold, released as a tap", () => {
    const onExpandedChange = vi.fn();
    render(
      <ComposerExpandHandle
        expanded={false}
        onExpandedChange={onExpandedChange}
      />,
    );
    const handle = getHandle();

    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 92, pointerId: 1 });
    expect(onExpandedChange).not.toHaveBeenCalled();

    fireEvent.pointerUp(handle, { clientY: 92, pointerId: 1 });
    expect(onExpandedChange).toHaveBeenCalledTimes(1);
    expect(onExpandedChange).toHaveBeenCalledWith(true);
  });

  it("prevents the default action on pointer down", () => {
    render(
      <ComposerExpandHandle expanded={false} onExpandedChange={vi.fn()} />,
    );
    const handle = getHandle();

    const notCancelled = fireEvent.pointerDown(handle, {
      clientY: 100,
      pointerId: 1,
    });

    expect(notCancelled).toBe(false);
  });

  it("reflects the collapsed state in its label and aria-expanded", () => {
    render(
      <ComposerExpandHandle expanded={false} onExpandedChange={vi.fn()} />,
    );

    const handle = screen.getByRole("button", { name: "Expand composer" });
    expect(handle.getAttribute("aria-expanded")).toBe("false");
  });

  it("reflects the expanded state in its label and aria-expanded", () => {
    render(<ComposerExpandHandle expanded onExpandedChange={vi.fn()} />);

    const handle = screen.getByRole("button", { name: "Collapse composer" });
    expect(handle.getAttribute("aria-expanded")).toBe("true");
  });

  it("toggles on keyboard or assistive activation, which arrives as a detail-0 click", () => {
    const onExpandedChange = vi.fn();
    render(
      <ComposerExpandHandle
        expanded={false}
        onExpandedChange={onExpandedChange}
      />,
    );

    fireEvent.click(getHandle(), { detail: 0 });
    expect(onExpandedChange).toHaveBeenCalledTimes(1);
    expect(onExpandedChange).toHaveBeenCalledWith(true);
  });

  it("does not toggle twice on the click that trails a real press", () => {
    const onExpandedChange = vi.fn();
    render(
      <ComposerExpandHandle
        expanded={false}
        onExpandedChange={onExpandedChange}
      />,
    );
    const handle = getHandle();

    fireEvent.pointerDown(handle, { clientY: 50, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 50, pointerId: 1 });
    fireEvent.click(handle, { detail: 1 });
    expect(onExpandedChange).toHaveBeenCalledTimes(1);
  });

  it("toggles the accessible state end to end through a tap", () => {
    render(<ControlledHandle initialExpanded={false} />);

    expect(
      screen.getByRole("button", { name: "Expand composer" }),
    ).not.toBeNull();

    const handle = getHandle();
    fireEvent.pointerDown(handle, { clientY: 50, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 50, pointerId: 1 });

    expect(
      screen.getByRole("button", { name: "Collapse composer" }),
    ).not.toBeNull();
  });
});
