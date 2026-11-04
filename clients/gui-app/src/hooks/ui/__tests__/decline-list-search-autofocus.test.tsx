/**
 * Driven through the real `Popover` and `Dialog`, which default
 * `onOpenAutoFocus` to the hook, so a surface that stopped wiring it fails
 * here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Popover, PopoverContent } from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

const realMatchMedia = window.matchMedia.bind(window);

function setPointer(coarse: boolean): void {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string): MediaQueryList =>
      Object.defineProperty(realMatchMedia(query), "matches", {
        configurable: true,
        value: query === "(pointer: coarse)" ? coarse : false,
      }),
  );
}

const SEARCH_FIELDS: ReadonlyArray<{
  readonly name: string;
  readonly props: Record<string, string>;
}> = [
  { name: "cmdk input", props: { "cmdk-input": "" } },
  { name: "type=search", props: { type: "search" } },
  { name: "Search placeholder", props: { placeholder: "Search models" } },
  { name: "Filter placeholder", props: { placeholder: "Filter repos" } },
];

type Surface = "popover" | "dialog";

function Surfaced(props: {
  readonly surface: Surface;
  readonly children: React.ReactNode;
}) {
  if (props.surface === "popover") {
    return (
      <Popover defaultOpen>
        <PopoverContent data-testid="content">{props.children}</PopoverContent>
      </Popover>
    );
  }
  return (
    <Dialog defaultOpen>
      <DialogContent data-testid="content">
        <DialogTitle>Title</DialogTitle>
        <DialogDescription>Description</DialogDescription>
        {props.children}
      </DialogContent>
    </Dialog>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe.each<Surface>(["popover", "dialog"])("a %s opened", (surface) => {
  describe.each(SEARCH_FIELDS)("on a list search ($name)", ({ props }) => {
    it("keeps the keyboard down on a coarse pointer and focuses the content", async () => {
      setPointer(true);
      render(
        <Surfaced surface={surface}>
          <input data-testid="field" {...props} />
          <button type="button">Row</button>
        </Surfaced>,
      );

      const content = screen.getByTestId("content");
      await waitFor(() => {
        expect(document.activeElement).toBe(content);
      });
      expect(document.activeElement).not.toBe(screen.getByTestId("field"));
    });

    it("still focuses the search on a fine pointer", async () => {
      setPointer(false);
      render(
        <Surfaced surface={surface}>
          <input data-testid="field" {...props} />
          <button type="button">Row</button>
        </Surfaced>,
      );

      await waitFor(() => {
        expect(document.activeElement).toBe(screen.getByTestId("field"));
      });
    });
  });

  it("still focuses a first field that is not a list search on a coarse pointer", async () => {
    setPointer(true);
    render(
      <Surfaced surface={surface}>
        <input data-testid="field" type="text" placeholder="Name" />
        <input type="search" placeholder="Search" />
      </Surfaced>,
    );

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId("field"));
    });
  });
});
