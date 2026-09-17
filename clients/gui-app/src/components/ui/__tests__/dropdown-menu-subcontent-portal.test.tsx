import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useState, type ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { DialogOverlayBoundaryContext } from "@/providers/dialog-overlay-boundary-context";

function MenuWithBoundary(): ReactNode {
  const [boundary, setBoundary] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setBoundary} data-testid="dialog-boundary">
      <DialogOverlayBoundaryContext.Provider value={boundary}>
        <DropdownMenu>
          <DropdownMenuTrigger>Open</DropdownMenuTrigger>
          <DropdownMenuContent data-testid="parent-menu">
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
              <DropdownMenuSubContent data-testid="submenu">
                <DropdownMenuItem>Nested item</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      </DialogOverlayBoundaryContext.Provider>
    </div>
  );
}

function MenuWithoutBoundary(): ReactNode {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent data-testid="parent-menu">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
          <DropdownMenuSubContent data-testid="submenu">
            <DropdownMenuItem>Nested item</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ContextSubmenu(): ReactNode {
  return (
    <ContextMenu>
      <ContextMenuTrigger data-testid="context-target">
        Right click
      </ContextMenuTrigger>
      <ContextMenuContent data-testid="context-parent-menu">
        <ContextMenuSub>
          <ContextMenuSubTrigger>More</ContextMenuSubTrigger>
          <ContextMenuSubContent data-testid="context-submenu">
            <ContextMenuItem>Nested item</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
      </ContextMenuContent>
    </ContextMenu>
  );
}

async function openSubmenu(): Promise<HTMLElement> {
  const trigger = screen.getByRole("button", { name: "Open" });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
  const submenuTrigger = screen.getByRole("menuitem", { name: "More" });
  submenuTrigger.focus();
  fireEvent.keyDown(submenuTrigger, { key: "ArrowRight" });
  return screen.findByTestId("submenu");
}

afterEach(cleanup);

describe("DropdownMenuSubContent portal ownership", () => {
  it("portals under the dialog boundary instead of the parent menu", async () => {
    render(<MenuWithBoundary />);

    const submenu = await openSubmenu();
    const boundary = screen.getByTestId("dialog-boundary");
    const parent = screen.getByTestId("parent-menu");
    expect(boundary.contains(submenu)).toBe(true);
    expect(parent.contains(submenu)).toBe(false);
  });

  it("still portals to document body outside a parent menu without a boundary", async () => {
    render(<MenuWithoutBoundary />);

    const submenu = await openSubmenu();
    expect(document.body.contains(submenu)).toBe(true);
    expect(screen.getByTestId("parent-menu").contains(submenu)).toBe(false);
  });

  it("portals context-menu submenus outside their parent content", async () => {
    render(<ContextSubmenu />);

    fireEvent.contextMenu(screen.getByTestId("context-target"));
    const submenuTrigger = screen.getByRole("menuitem", { name: "More" });
    submenuTrigger.focus();
    fireEvent.keyDown(submenuTrigger, { key: "ArrowRight" });

    const submenu = await screen.findByTestId("context-submenu");
    expect(document.body.contains(submenu)).toBe(true);
    expect(screen.getByTestId("context-parent-menu").contains(submenu)).toBe(
      false,
    );
  });
});
