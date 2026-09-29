/**
 * `TooltipWrapper` always mounts `Tooltip`/`TooltipTrigger` now (`disabled`
 * tracks the empty-label case) so the trigger's own DOM node - and any
 * popover/menu anchored to it - never remounts when a caller toggles
 * `label` between empty and non-empty (T11: this used to swap the returned
 * root element type on that transition, which is why the notifications and
 * avatar popovers anchored at the viewport origin instead of their trigger).
 */
import { createRef, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";

afterEach(cleanup);

const EMPTY_LABELS: ReadonlyArray<readonly [string, ReactNode]> = [
  ["an empty string", ""],
  ["null", null],
  ["undefined", undefined],
];

describe("TooltipWrapper empty-label suppression", () => {
  it.each(EMPTY_LABELS)(
    "never presents a tooltip for %s label, even while focused",
    (_name, label) => {
      render(
        <TooltipWrapper
          label={label}
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <button type="button">Target</button>
        </TooltipWrapper>,
      );

      const button = screen.getByRole("button", { name: "Target" });
      fireEvent.focus(button);
      expect(screen.queryByRole("tooltip")).toBeNull();
      expect(button.getAttribute("aria-describedby")).toBeNull();
    },
  );

  it("stays suppressed even when the caller forces it open", () => {
    render(
      <TooltipWrapper
        label={null}
        open
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <button type="button">Target</button>
      </TooltipWrapper>,
    );

    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("keeps the trigger's own DOM node across a label toggle (anchor identity)", () => {
    const childRef = createRef<HTMLButtonElement>();
    const view = render(
      <TooltipWrapper
        label={null}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <button type="button" ref={childRef}>
          Target
        </button>
      </TooltipWrapper>,
    );
    const node = childRef.current;
    expect(node).not.toBeNull();

    view.rerender(
      <TooltipWrapper
        label="Hint"
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <button type="button" ref={childRef}>
          Target
        </button>
      </TooltipWrapper>,
    );
    expect(childRef.current).toBe(node);

    view.rerender(
      <TooltipWrapper
        label={null}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <button type="button" ref={childRef}>
          Target
        </button>
      </TooltipWrapper>,
    );
    expect(childRef.current).toBe(node);
  });

  it("keeps the child's own click handler working with no outer trigger", () => {
    const onClick = vi.fn();
    render(
      <TooltipWrapper
        label={null}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <button type="button" onClick={onClick}>
          Target
        </button>
      </TooltipWrapper>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Target" }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it.each<[string, ReactNode]>([
    ["an empty label", null],
    ["a real label", "Hint"],
  ])(
    "composes with an outer render trigger for %s: the outer DropdownMenuTrigger ref and the child's own ref resolve to the same button, and both the trigger's open handler and the child's own click handler fire",
    (_name, label) => {
      const onClick = vi.fn();
      const outerRef = createRef<HTMLElement>();
      const childRef = createRef<HTMLButtonElement>();

      render(
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <TooltipWrapper
                ref={outerRef}
                label={label}
                side="top"
                sideOffset={undefined}
                align={undefined}
              >
                <button type="button" ref={childRef} onClick={onClick}>
                  Menu
                </button>
              </TooltipWrapper>
            }
          />
          <DropdownMenuContent>
            <DropdownMenuItem>Item</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>,
      );

      const trigger = screen.getByRole("button", { name: "Menu" });
      expect(outerRef.current).toBe(trigger);
      expect(childRef.current).toBe(trigger);

      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(trigger);

      // Both outcomes from the one composed element: the trigger's injected
      // open handler fired (the menu opened) and the child's own handler still
      // fired - composition, not replacement.
      expect(screen.getByRole("menuitem", { name: "Item" })).toBeTruthy();
      expect(onClick).toHaveBeenCalledTimes(1);
    },
  );
});
