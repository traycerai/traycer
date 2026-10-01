import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

import { useComposerSheetPin } from "../use-composer-sheet-pin";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Sheet({ expanded }: { readonly expanded: boolean }): ReactNode {
  const { slotRef, sheetRef } = useComposerSheetPin(expanded);
  return (
    <div data-testid="origin">
      {expanded ? <div ref={slotRef} data-testid="slot" /> : null}
      <div ref={sheetRef} data-testid="sheet" />
    </div>
  );
}

it("gives the open sheet its slot's box, and takes it back on collapse", () => {
  // jsdom lays nothing out, so the geometry is supplied.
  vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(
    () => screen.getByTestId("origin"),
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this.dataset.testid === "slot"
        ? new DOMRect(16, 50, 370, 700)
        : new DOMRect(12, 600, 0, 0);
    },
  );

  const view = render(<Sheet expanded />);
  const { style } = screen.getByTestId("sheet");
  expect(style.cssText).toBe(
    "left: 4px; top: max(-550px, var(--composer-sheet-top, -550px)); width: 370px; bottom: -150px;",
  );

  view.rerender(<Sheet expanded={false} />);
  expect(style.cssText).toBe("");
});
