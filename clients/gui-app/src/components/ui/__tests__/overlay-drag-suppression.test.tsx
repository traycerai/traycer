/**
 * Every overlay primitive holds the window's drag regions down for exactly as
 * long as it presents. A drag region takes its clicks at the OS level, before
 * the DOM, so an overlay painted over the side strip or the header is dead
 * there unless the region stands down - the Fork dialog's model picker opened
 * its provider rail over the strip, and the rail ignored every click.
 */
import "../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarTrigger,
} from "@/components/ui/menubar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  useTitleBarDraggingSuppressed,
  useTitleBarDragStore,
} from "@/stores/layout/title-bar-drag-store";

// The answer the side strip and the header read to pick `drag` or `no-drag`.
function DragProbe(): ReactNode {
  return (
    <output data-testid="drag-suppressed">
      {String(useTitleBarDraggingSuppressed())}
    </output>
  );
}

function dragSuppressed(): boolean {
  return screen.getByTestId("drag-suppressed").textContent === "true";
}

type ControlledOverlay = (open: boolean) => ReactNode;

const CONTROLLED_OVERLAYS: ReadonlyArray<readonly [string, ControlledOverlay]> =
  [
    [
      "dialog",
      (open) => (
        <Dialog open={open}>
          <DialogContent>
            <DialogTitle>Title</DialogTitle>
            <DialogDescription>Body</DialogDescription>
          </DialogContent>
        </Dialog>
      ),
    ],
    [
      "sheet",
      (open) => (
        <Sheet open={open}>
          <SheetContent>
            <SheetTitle>Title</SheetTitle>
            <SheetDescription>Body</SheetDescription>
          </SheetContent>
        </Sheet>
      ),
    ],
    [
      "drawer",
      (open) => (
        <Drawer open={open}>
          <DrawerContent>
            <DrawerTitle>Title</DrawerTitle>
            <DrawerDescription>Body</DrawerDescription>
          </DrawerContent>
        </Drawer>
      ),
    ],
    [
      "popover",
      (open) => (
        <Popover open={open}>
          <PopoverTrigger>Open</PopoverTrigger>
          <PopoverContent>Body</PopoverContent>
        </Popover>
      ),
    ],
    [
      "dropdown menu",
      (open) => (
        <DropdownMenu open={open}>
          <DropdownMenuTrigger>Open</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Item</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    ],
    [
      "select",
      // A closed Select still renders its items, into a detached fragment, so
      // the trigger can show the chosen label. That must not hold the regions.
      (open) => (
        <Select open={open} value="a">
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="a">Alpha</SelectItem>
          </SelectContent>
        </Select>
      ),
    ],
    [
      "menubar",
      (open) => (
        <Menubar value={open ? "file" : ""}>
          <MenubarMenu value="file">
            <MenubarTrigger>File</MenubarTrigger>
            <MenubarContent>
              <MenubarItem>Item</MenubarItem>
            </MenubarContent>
          </MenubarMenu>
        </Menubar>
      ),
    ],
  ];

beforeEach(() => {
  useTitleBarDragStore.setState({ suppressors: new Set() });
});

afterEach(() => {
  cleanup();
});

describe("overlay primitives and the window drag regions", () => {
  it.each(CONTROLLED_OVERLAYS)(
    "a %s holds the drag regions down only while it is open",
    async (_name, overlay) => {
      const view = render(
        <>
          <DragProbe />
          {overlay(false)}
        </>,
      );
      expect(dragSuppressed()).toBe(false);

      view.rerender(
        <>
          <DragProbe />
          {overlay(true)}
        </>,
      );
      expect(dragSuppressed()).toBe(true);

      view.rerender(
        <>
          <DragProbe />
          {overlay(false)}
        </>,
      );
      await vi.waitFor(() => expect(dragSuppressed()).toBe(false));
    },
  );

  it("a context menu holds the drag regions down only while it is open", async () => {
    render(
      <>
        <DragProbe />
        <ContextMenu>
          <ContextMenuTrigger>Target</ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem>Item</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </>,
    );
    expect(dragSuppressed()).toBe(false);

    fireEvent.contextMenu(screen.getByText("Target"));
    await screen.findByText("Item");
    expect(dragSuppressed()).toBe(true);

    act(() => {
      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: "Escape",
      });
    });
    await vi.waitFor(() => expect(dragSuppressed()).toBe(false));
  });

  it("a popover inside a dialog leaves the regions down until the dialog closes too", async () => {
    function ForkLike(props: {
      readonly dialogOpen: boolean;
      readonly pickerOpen: boolean;
    }): ReactNode {
      return (
        <>
          <DragProbe />
          <Dialog open={props.dialogOpen}>
            <DialogContent>
              <DialogTitle>Fork agent</DialogTitle>
              <DialogDescription>Body</DialogDescription>
              <Popover open={props.pickerOpen}>
                <PopoverTrigger>Model</PopoverTrigger>
                <PopoverContent>Providers</PopoverContent>
              </Popover>
            </DialogContent>
          </Dialog>
        </>
      );
    }
    const view = render(<ForkLike dialogOpen pickerOpen />);
    expect(dragSuppressed()).toBe(true);

    view.rerender(<ForkLike dialogOpen pickerOpen={false} />);
    await vi.waitFor(() => expect(screen.queryByText("Providers")).toBeNull());
    expect(dragSuppressed()).toBe(true);

    view.rerender(<ForkLike dialogOpen={false} pickerOpen={false} />);
    await vi.waitFor(() => expect(dragSuppressed()).toBe(false));
  });
});
