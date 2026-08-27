import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useShadowScrollerTouchShield } from "@/hooks/ui/use-shadow-scroller-touch-shield";

/**
 * jsdom has no `TouchEvent` constructor, so these dispatch plain `Event`
 * instances named "touchmove" / "touchstart" - the hook only ever reads
 * `stopPropagation()`, never a Touch-specific payload, so a bubbling plain
 * `Event` exercises the same code path.
 */
function dispatchBubbling(target: Element, type: string): void {
  target.dispatchEvent(new Event(type, { bubbles: true }));
}

function TouchShieldHarness(props: { readonly shielded: boolean }) {
  const touchShieldRef = useShadowScrollerTouchShield();
  return (
    <div data-testid="outer">
      <div data-testid="wrapper" ref={props.shielded ? touchShieldRef : null}>
        <div data-testid="child" />
      </div>
    </div>
  );
}

describe("useShadowScrollerTouchShield", () => {
  afterEach(() => {
    cleanup();
  });

  it("stops a bubbling touchmove from a descendant reaching the document", () => {
    render(<TouchShieldHarness shielded />);
    const documentTouchMove = vi.fn();
    document.addEventListener("touchmove", documentTouchMove);
    try {
      dispatchBubbling(screen.getByTestId("child"), "touchmove");
      expect(documentTouchMove).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("touchmove", documentTouchMove);
    }
  });

  it("still lets a listener on the touched element itself see the touchmove", () => {
    render(<TouchShieldHarness shielded />);
    const child = screen.getByTestId("child");
    const childTouchMove = vi.fn();
    child.addEventListener("touchmove", childTouchMove);
    try {
      dispatchBubbling(child, "touchmove");
      expect(childTouchMove).toHaveBeenCalledTimes(1);
    } finally {
      child.removeEventListener("touchmove", childTouchMove);
    }
  });

  it("leaves touchstart alone - only touchmove is shielded", () => {
    render(<TouchShieldHarness shielded />);
    const documentTouchStart = vi.fn();
    document.addEventListener("touchstart", documentTouchStart);
    try {
      dispatchBubbling(screen.getByTestId("child"), "touchstart");
      expect(documentTouchStart).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("touchstart", documentTouchStart);
    }
  });

  it("stops shielding once the ref detaches, letting touchmove reach the document again", () => {
    const { rerender } = render(<TouchShieldHarness shielded />);
    rerender(<TouchShieldHarness shielded={false} />);

    const documentTouchMove = vi.fn();
    document.addEventListener("touchmove", documentTouchMove);
    try {
      dispatchBubbling(screen.getByTestId("child"), "touchmove");
      expect(documentTouchMove).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("touchmove", documentTouchMove);
    }
  });
});
