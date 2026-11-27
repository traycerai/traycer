import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRowSwipeTray } from "@/components/epics/mobile/use-row-swipe-tray";
import { setSystemGestureInsets } from "@/lib/system-gesture-insets";

/**
 * An open tray is put away by a rightward drag, which is also the navigation
 * swipe's direction at the leading edge. The row yields the strip the shell
 * owns, and that strip now begins past the OS's own gesture strip, so where a
 * touch lands decides which recognizer takes it. Driven with real pointer
 * events through the real hook.
 */
function Row(props: {
  readonly isOpen: boolean;
  readonly onDragStart: () => void;
}) {
  const tray = useRowSwipeTray({
    actionCount: 2,
    isOpen: props.isOpen,
    onOpenChange: () => {},
    disabled: false,
    onDragStart: props.onDragStart,
  });
  return <div data-testid="row" {...tray.handlers} />;
}

function dragBy(from: number, travel: number): void {
  const row = screen.getByTestId("row");
  const touch = { pointerType: "touch", isPrimary: true, pointerId: 1 };
  fireEvent.pointerDown(row, { ...touch, clientX: from, clientY: 300 });
  fireEvent.pointerMove(row, {
    ...touch,
    clientX: from + travel,
    clientY: 300,
  });
}

function dragRight(from: number): void {
  dragBy(from, 60);
}

describe("an open row tray's close swipe and the leading edge strip", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", {
      value: 400,
      configurable: true,
    });
  });
  afterEach(() => {
    cleanup();
    setSystemGestureInsets({ left: 0, right: 0 });
  });

  it("takes a close swipe that starts past the band", () => {
    const onDragStart = vi.fn();
    render(<Row isOpen onDragStart={onDragStart} />);

    dragRight(40);

    expect(onDragStart).toHaveBeenCalledTimes(1);
  });

  it("yields a swipe that starts inside the band the OS strip pushed inboard", () => {
    setSystemGestureInsets({ left: 20, right: 0 });
    const onDragStart = vi.fn();
    render(<Row isOpen onDragStart={onDragStart} />);

    dragRight(40);

    expect(onDragStart).not.toHaveBeenCalled();
  });

  it("yields the whole viewport when system insets cross", () => {
    setSystemGestureInsets({ left: 250, right: 250 });
    const onDragStart = vi.fn();
    render(<Row isOpen onDragStart={onDragStart} />);

    dragRight(200);

    expect(onDragStart).not.toHaveBeenCalled();
  });

  it("yields a swipe that starts inside the OS strip itself", () => {
    setSystemGestureInsets({ left: 60, right: 0 });
    const onDragStart = vi.fn();
    render(<Row isOpen onDragStart={onDragStart} />);

    dragRight(40);

    expect(onDragStart).not.toHaveBeenCalled();
  });
});
