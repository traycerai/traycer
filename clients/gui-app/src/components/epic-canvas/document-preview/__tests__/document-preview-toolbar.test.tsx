/**
 * `DocumentPreviewToolbar`'s shared contract (document-preview-toolbar.tsx):
 * the landmark's accessible name comes from the caller (PDF vs Word say
 * different things), the three-tier folding - `@max-lg` for outline/fit-
 * width/rotate/search, `@max-sm` for zoom, page nav never folds - keeps a
 * narrow split pane from losing a control the wide layout offers, the "More
 * actions" menu carries the same actions under the same labels once folded,
 * `onRotate`/`outline`/`searchSupported` withdraw a control everywhere (not
 * just inline) when a renderer doesn't offer it, and the page-number field
 * owns its own typed-draft lifecycle independent of the viewer's own
 * `pageNumber` prop. One suite covers both viewers because they render the
 * exact same component.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  DocumentPreviewToolbar,
  type DocumentPreviewToolbarProps,
} from "../document-preview-toolbar";

function baseProps(
  overrides: Partial<DocumentPreviewToolbarProps>,
): DocumentPreviewToolbarProps {
  return {
    ariaLabel: "PDF preview controls",
    fileName: "report.pdf",
    compact: false,
    toolbarActions: null,
    documentReady: true,
    pageNumber: 2,
    pageCount: 5,
    onGoToPage: vi.fn(),
    scalePercent: 125,
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    onFitWidth: vi.fn(),
    onRotate: vi.fn(),
    outline: { open: false, onToggle: vi.fn() },
    searchSupported: true,
    searchOpen: false,
    onToggleSearch: vi.fn(),
    ...overrides,
  };
}

function renderToolbar(
  overrides: Partial<DocumentPreviewToolbarProps> = {},
): DocumentPreviewToolbarProps {
  const props = baseProps(overrides);
  render(<DocumentPreviewToolbar {...props} />);
  return props;
}

function openMoreActionsMenu(): void {
  // Radix's DropdownMenuTrigger opens on pointerdown, not the click event -
  // same pattern as `epic-sidebar-filter-menu.test.tsx`.
  fireEvent.pointerDown(screen.getByRole("button", { name: "More actions" }), {
    button: 0,
  });
}

describe("<DocumentPreviewToolbar />", () => {
  afterEach(() => {
    cleanup();
  });

  it("names the toolbar landmark from ariaLabel", () => {
    renderToolbar({ ariaLabel: "Word document preview controls" });

    expect(
      screen.getByRole("toolbar", { name: "Word document preview controls" }),
    ).toBeTruthy();
  });

  describe("three-tier folding", () => {
    it("folds outline, fit-width, rotate, search and the separator ahead of search under @max-lg", () => {
      renderToolbar();

      expect(
        screen.getByRole("button", { name: "Document outline" }).className,
      ).toContain("@max-lg:hidden");
      expect(
        screen.getByRole("button", { name: "Fit to width" }).className,
      ).toContain("@max-lg:hidden");
      expect(
        screen.getByRole("button", { name: "Rotate" }).className,
      ).toContain("@max-lg:hidden");
      expect(
        screen.getByRole("button", { name: "Search document" }).className,
      ).toContain("@max-lg:hidden");

      const searchSeparator = screen.getByRole("button", {
        name: "Search document",
      }).previousElementSibling;
      expect(searchSeparator?.getAttribute("aria-hidden")).toBe("true");
      expect(searchSeparator?.className).toContain("@max-lg:hidden");
    });

    it("folds zoom out/level/in and their separator under @max-sm, but never page nav", () => {
      renderToolbar();

      expect(
        screen.getByRole("button", { name: "Zoom out" }).className,
      ).toContain("@max-sm:hidden");
      expect(screen.getByLabelText("Zoom level").className).toContain(
        "@max-sm:hidden",
      );
      expect(
        screen.getByRole("button", { name: "Zoom in" }).className,
      ).toContain("@max-sm:hidden");

      const zoomSeparator = screen.getByRole("button", {
        name: "Zoom out",
      }).previousElementSibling;
      expect(zoomSeparator?.getAttribute("aria-hidden")).toBe("true");
      expect(zoomSeparator?.className).toContain("@max-sm:hidden");

      expect(
        screen.getByRole("button", { name: "Previous page" }).className,
      ).not.toContain("@max-sm:hidden");
      expect(
        screen.getByRole("button", { name: "Next page" }).className,
      ).not.toContain("@max-sm:hidden");
    });

    it("shows the More actions trigger only under @max-lg", () => {
      renderToolbar();

      const trigger = screen.getByRole("button", { name: "More actions" });
      expect(trigger.className).toContain("hidden");
      expect(trigger.className).toContain("@max-lg:inline-flex");
    });
  });

  describe("More actions menu", () => {
    it("wires Zoom in to onZoomIn", () => {
      const onZoomIn = vi.fn();
      renderToolbar({ onZoomIn });

      openMoreActionsMenu();
      fireEvent.click(screen.getByText("Zoom in"));

      expect(onZoomIn).toHaveBeenCalledTimes(1);
    });

    it("wires Zoom out to onZoomOut", () => {
      const onZoomOut = vi.fn();
      renderToolbar({ onZoomOut });

      openMoreActionsMenu();
      fireEvent.click(screen.getByText("Zoom out"));

      expect(onZoomOut).toHaveBeenCalledTimes(1);
    });

    it("wires Fit to width to onFitWidth", () => {
      const onFitWidth = vi.fn();
      renderToolbar({ onFitWidth });

      openMoreActionsMenu();
      fireEvent.click(screen.getByText("Fit to width"));

      expect(onFitWidth).toHaveBeenCalledTimes(1);
    });

    it("wires Rotate 90° to onRotate", () => {
      const onRotate = vi.fn();
      renderToolbar({ onRotate });

      openMoreActionsMenu();
      fireEvent.click(screen.getByText("Rotate 90°"));

      expect(onRotate).toHaveBeenCalledTimes(1);
    });

    it("wires the Document outline checkbox to outline.onToggle", () => {
      const onToggle = vi.fn();
      renderToolbar({ outline: { open: false, onToggle } });

      openMoreActionsMenu();
      fireEvent.click(screen.getByText("Document outline"));

      expect(onToggle).toHaveBeenCalledTimes(1);
    });

    it("wires the Search document checkbox to onToggleSearch", () => {
      const onToggleSearch = vi.fn();
      renderToolbar({ onToggleSearch });

      openMoreActionsMenu();
      fireEvent.click(screen.getByText("Search document"));

      expect(onToggleSearch).toHaveBeenCalledTimes(1);
    });
  });

  describe("optional controls withdraw everywhere, not just inline", () => {
    it("omits Rotate inline and from the menu when onRotate is null", () => {
      renderToolbar({ onRotate: null });

      expect(screen.queryByRole("button", { name: "Rotate" })).toBeNull();

      openMoreActionsMenu();
      expect(screen.queryByText("Rotate 90°")).toBeNull();
    });

    it("omits the outline button and menu item when outline is null", () => {
      renderToolbar({ outline: null });

      expect(
        screen.queryByRole("button", { name: "Document outline" }),
      ).toBeNull();

      openMoreActionsMenu();
      expect(screen.queryByText("Document outline")).toBeNull();
    });

    it("omits the Search button, its separator and the menu item when searchSupported is false", () => {
      renderToolbar({ searchSupported: false });

      expect(
        screen.queryByRole("button", { name: "Search document" }),
      ).toBeNull();
      // No separator survives between Rotate and the More actions trigger
      // once Search (and its leading separator) are gone.
      expect(
        screen.getByRole("button", { name: "Rotate" }).nextElementSibling,
      ).toBe(screen.getByRole("button", { name: "More actions" }));

      openMoreActionsMenu();
      expect(screen.queryByText("Search document")).toBeNull();
    });
  });

  describe("page navigation", () => {
    it("calls onGoToPage with pageNumber + 1 from Next page", () => {
      const onGoToPage = vi.fn();
      renderToolbar({ pageNumber: 2, pageCount: 5, onGoToPage });

      fireEvent.click(screen.getByRole("button", { name: "Next page" }));

      expect(onGoToPage).toHaveBeenCalledWith(3);
    });

    it("calls onGoToPage with pageNumber - 1 from Previous page", () => {
      const onGoToPage = vi.fn();
      renderToolbar({ pageNumber: 2, pageCount: 5, onGoToPage });

      fireEvent.click(screen.getByRole("button", { name: "Previous page" }));

      expect(onGoToPage).toHaveBeenCalledWith(1);
    });

    it("disables Previous at page 1", () => {
      renderToolbar({ pageNumber: 1, pageCount: 5 });

      expect(
        screen
          .getByRole("button", { name: "Previous page" })
          .hasAttribute("disabled"),
      ).toBe(true);
    });

    it("disables Next at the last page", () => {
      renderToolbar({ pageNumber: 5, pageCount: 5 });

      expect(
        screen
          .getByRole("button", { name: "Next page" })
          .hasAttribute("disabled"),
      ).toBe(true);
    });

    it("disables Previous and Next while the document is not ready, regardless of page", () => {
      renderToolbar({ documentReady: false, pageNumber: 2, pageCount: 5 });

      expect(
        screen
          .getByRole("button", { name: "Previous page" })
          .hasAttribute("disabled"),
      ).toBe(true);
      expect(
        screen
          .getByRole("button", { name: "Next page" })
          .hasAttribute("disabled"),
      ).toBe(true);
    });
  });

  describe("the page-number field", () => {
    function pageField(): HTMLInputElement {
      return screen.getByLabelText<HTMLInputElement>("Page number");
    }

    it("shows pageNumber while idle", () => {
      renderToolbar({ pageNumber: 3, pageCount: 5 });

      expect(pageField().value).toBe("3");
    });

    it("is empty and disabled while the document is not ready, and the count shows a dash", () => {
      renderToolbar({ documentReady: false, pageNumber: 1, pageCount: 0 });

      expect(pageField().value).toBe("");
      expect(pageField().disabled).toBe(true);
      expect(screen.getByText("/ –")).toBeTruthy();
    });

    it("keeps the typed draft even if pageNumber changes underneath it", () => {
      const props = baseProps({ pageNumber: 2, pageCount: 5 });
      const { rerender } = render(<DocumentPreviewToolbar {...props} />);

      fireEvent.change(pageField(), { target: { value: "9" } });
      rerender(
        <DocumentPreviewToolbar {...props} pageNumber={4} pageCount={5} />,
      );

      expect(pageField().value).toBe("9");
    });

    it("commits the parsed value on Enter", () => {
      const onGoToPage = vi.fn();
      renderToolbar({ pageNumber: 2, pageCount: 5, onGoToPage });

      fireEvent.change(pageField(), { target: { value: "4" } });
      fireEvent.keyDown(pageField(), { key: "Enter" });

      expect(onGoToPage).toHaveBeenCalledWith(4);
    });

    it("commits on blur too", () => {
      const onGoToPage = vi.fn();
      renderToolbar({ pageNumber: 2, pageCount: 5, onGoToPage });

      fireEvent.change(pageField(), { target: { value: "3" } });
      fireEvent.blur(pageField());

      expect(onGoToPage).toHaveBeenCalledWith(3);
    });

    it("clamps an out-of-range value into [1, pageCount] before committing", () => {
      const onGoToPage = vi.fn();
      renderToolbar({ pageNumber: 2, pageCount: 5, onGoToPage });

      fireEvent.change(pageField(), { target: { value: "99" } });
      fireEvent.keyDown(pageField(), { key: "Enter" });
      expect(onGoToPage).toHaveBeenCalledWith(5);

      fireEvent.change(pageField(), { target: { value: "0" } });
      fireEvent.keyDown(pageField(), { key: "Enter" });
      expect(onGoToPage).toHaveBeenCalledWith(1);
    });

    it("commits nothing for non-numeric input and falls back to pageNumber", () => {
      const onGoToPage = vi.fn();
      renderToolbar({ pageNumber: 2, pageCount: 5, onGoToPage });

      fireEvent.change(pageField(), { target: { value: "abc" } });
      fireEvent.keyDown(pageField(), { key: "Enter" });

      expect(onGoToPage).not.toHaveBeenCalled();
      expect(pageField().value).toBe("2");
    });

    it("clears the draft after a commit, showing pageNumber again", () => {
      renderToolbar({ pageNumber: 2, pageCount: 5 });

      fireEvent.change(pageField(), { target: { value: "4" } });
      fireEvent.keyDown(pageField(), { key: "Enter" });

      // onGoToPage is a mock here - it never feeds a new pageNumber prop
      // back in, so a cleared draft must fall back to the original prop.
      expect(pageField().value).toBe("2");
    });
  });

  it("disables zoom, fit-width, rotate, search and the page field while the document is not ready", () => {
    renderToolbar({ documentReady: false, pageNumber: 1, pageCount: 0 });

    for (const name of [
      "Zoom out",
      "Zoom in",
      "Fit to width",
      "Rotate",
      "Search document",
    ]) {
      expect(
        screen.getByRole("button", { name }).hasAttribute("disabled"),
      ).toBe(true);
    }
    expect(
      screen.getByLabelText<HTMLInputElement>("Page number").disabled,
    ).toBe(true);
  });
});
