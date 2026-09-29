import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { Popover, PopoverContent } from "@/components/ui/popover";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const VIEWPORT = { width: 1920, height: 1080 };
const POPUP = { width: 400, height: 200 };
const ANCHOR = { left: 0, top: 1040, width: 1900, height: 40 };
const COLLISION_PADDING_PX = 12;

function positionedAt(positioner: HTMLElement): { x: number; y: number } {
  const translate = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(
    positioner.style.transform,
  );
  return translate === null
    ? {
        x: Number.parseFloat(positioner.style.left),
        y: Number.parseFloat(positioner.style.top),
      }
    : { x: Number(translate[1]), y: Number(translate[2]) };
}

describe("<PopoverContent /> placement against a wide anchor", () => {
  it("keeps a side=top align=start popover at the left edge instead of flipping to the far right", async () => {
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(
      VIEWPORT.width,
    );
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(
      VIEWPORT.height,
    );
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(
      POPUP.width,
    );
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(
      POPUP.height,
    );

    // The status bar's flexible span: it starts at x=0 and spans the bar.
    const anchor = document.createElement("span");
    document.body.appendChild(anchor);
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(
      new DOMRect(ANCHOR.left, ANCHOR.top, ANCHOR.width, ANCHOR.height),
    );

    render(
      <Popover open>
        <PopoverContent
          anchor={anchor}
          side="top"
          align="start"
          collisionPadding={COLLISION_PADDING_PX}
        >
          content
        </PopoverContent>
      </Popover>,
    );

    const positioner = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(
        '[data-slot="popover-positioner"]',
      );
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });

    await waitFor(() => {
      const { x } = positionedAt(positioner);
      expect(x).toBeGreaterThan(0);
    });

    const { x, y } = positionedAt(positioner);
    expect(x).toBeCloseTo(COLLISION_PADDING_PX, 0);
    expect(y + POPUP.height).toBeLessThanOrEqual(ANCHOR.top);
    expect(positioner.getAttribute("data-side")).toBe("top");
  });
});
