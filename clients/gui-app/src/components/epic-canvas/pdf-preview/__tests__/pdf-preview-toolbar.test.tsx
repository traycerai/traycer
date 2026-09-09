/**
 * `PdfPreviewToolbar`'s three-tier contract (pdf-preview-toolbar.tsx): the
 * outline, fit-width, rotate and search controls (plus the separator ahead
 * of search) fold away under `@max-lg`, replaced by the "More actions" menu
 * that carries the same actions under the same labels - so a narrow split
 * pane never loses a control the wide layout offers. Under the narrowest
 * `@max-sm` tier, the inline zoom controls (and their separator) fold away
 * too, while page nav and the surface's own actions stay inline - the menu
 * lists Zoom in / Zoom out unconditionally so they are reachable at every
 * width.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  PdfPreviewToolbar,
  type PdfPreviewToolbarProps,
} from "../pdf-preview-toolbar";

const DEFAULT_PROPS: PdfPreviewToolbarProps = {
  fileName: "report.pdf",
  compact: false,
  toolbarActions: null,
  documentReady: true,
  pageNumber: 2,
  pageCount: 5,
  pageInput: "2",
  onPageInputChange: vi.fn(),
  onPageInputCommit: vi.fn(),
  onGoToPage: vi.fn(),
  scalePercent: 125,
  onZoomIn: vi.fn(),
  onZoomOut: vi.fn(),
  onFitWidth: vi.fn(),
  onRotate: vi.fn(),
  hasOutline: true,
  outlineOpen: false,
  onToggleOutline: vi.fn(),
  searchOpen: false,
  onToggleSearch: vi.fn(),
};

function openMoreActionsMenu(): void {
  // Radix's DropdownMenuTrigger opens on pointerdown, not the click event -
  // same pattern as `epic-sidebar-filter-menu.test.tsx`.
  fireEvent.pointerDown(screen.getByRole("button", { name: "More actions" }), {
    button: 0,
  });
}

describe("<PdfPreviewToolbar />", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the toolbar landmark with its accessible name", () => {
    render(<PdfPreviewToolbar {...DEFAULT_PROPS} />);

    expect(
      screen.getByRole("toolbar", { name: "PDF preview controls" }),
    ).toBeTruthy();
  });

  it("folds the outline, fit-width, rotate, search buttons and their separator under @max-lg", () => {
    render(<PdfPreviewToolbar {...DEFAULT_PROPS} />);

    expect(
      screen.getByRole("button", { name: "Document outline" }).className,
    ).toContain("@max-lg:hidden");
    expect(
      screen.getByRole("button", { name: "Fit to width" }).className,
    ).toContain("@max-lg:hidden");
    expect(screen.getByRole("button", { name: "Rotate" }).className).toContain(
      "@max-lg:hidden",
    );
    expect(
      screen.getByRole("button", { name: "Search document" }).className,
    ).toContain("@max-lg:hidden");

    // The one separator that folds away sits right before Search - the
    // earlier separator (next-page / zoom) stays inline at every width.
    const searchSeparator = screen.getByRole("button", {
      name: "Search document",
    }).previousElementSibling;
    expect(searchSeparator?.getAttribute("aria-hidden")).toBe("true");
    expect(searchSeparator?.className).toContain("@max-lg:hidden");
  });

  it("folds the zoom controls and their separator under @max-sm, but not the page nav buttons", () => {
    render(<PdfPreviewToolbar {...DEFAULT_PROPS} />);

    expect(
      screen.getByRole("button", { name: "Zoom out" }).className,
    ).toContain("@max-sm:hidden");
    expect(screen.getByLabelText("Zoom level").className).toContain(
      "@max-sm:hidden",
    );
    expect(screen.getByRole("button", { name: "Zoom in" }).className).toContain(
      "@max-sm:hidden",
    );

    // The separator sits right before Zoom out.
    const zoomSeparator = screen.getByRole("button", {
      name: "Zoom out",
    }).previousElementSibling;
    expect(zoomSeparator?.getAttribute("aria-hidden")).toBe("true");
    expect(zoomSeparator?.className).toContain("@max-sm:hidden");

    // Page nav stays inline at every width - the escape hatch never folds.
    expect(
      screen.getByRole("button", { name: "Previous page" }).className,
    ).not.toContain("@max-sm:hidden");
    expect(
      screen.getByRole("button", { name: "Next page" }).className,
    ).not.toContain("@max-sm:hidden");
  });

  it("shows the More actions trigger only under @max-lg", () => {
    render(<PdfPreviewToolbar {...DEFAULT_PROPS} />);

    const trigger = screen.getByRole("button", { name: "More actions" });
    expect(trigger.className).toContain("hidden");
    expect(trigger.className).toContain("@max-lg:inline-flex");
  });

  it("wires the More actions menu's Zoom in item to onZoomIn", () => {
    const onZoomIn = vi.fn();
    render(<PdfPreviewToolbar {...DEFAULT_PROPS} onZoomIn={onZoomIn} />);

    openMoreActionsMenu();
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.click(screen.getByText("Zoom in"));
    expect(onZoomIn).toHaveBeenCalledTimes(1);
  });

  it("wires the More actions menu's Zoom out item to onZoomOut", () => {
    const onZoomOut = vi.fn();
    render(<PdfPreviewToolbar {...DEFAULT_PROPS} onZoomOut={onZoomOut} />);

    openMoreActionsMenu();
    fireEvent.click(screen.getByText("Zoom out"));
    expect(onZoomOut).toHaveBeenCalledTimes(1);
  });

  it("wires the More actions menu's Fit to width item to onFitWidth", () => {
    const onFitWidth = vi.fn();
    render(<PdfPreviewToolbar {...DEFAULT_PROPS} onFitWidth={onFitWidth} />);

    openMoreActionsMenu();
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.click(screen.getByText("Fit to width"));
    expect(onFitWidth).toHaveBeenCalledTimes(1);
  });

  it("wires the More actions menu's Search document item to onToggleSearch", () => {
    const onToggleSearch = vi.fn();
    render(
      <PdfPreviewToolbar {...DEFAULT_PROPS} onToggleSearch={onToggleSearch} />,
    );

    openMoreActionsMenu();
    fireEvent.click(screen.getByText("Search document"));
    expect(onToggleSearch).toHaveBeenCalledTimes(1);
  });

  it("omits the Document outline item from the menu when hasOutline is false", () => {
    render(<PdfPreviewToolbar {...DEFAULT_PROPS} hasOutline={false} />);

    // The inline outline button is gone too - there is no outline control
    // at any width for a document with no outline.
    expect(
      screen.queryByRole("button", { name: "Document outline" }),
    ).toBeNull();

    openMoreActionsMenu();
    expect(screen.queryByText("Document outline")).toBeNull();
    expect(screen.getByText("Fit to width")).toBeTruthy();
  });

  it("calls onGoToPage with the next page number", () => {
    const onGoToPage = vi.fn();
    render(<PdfPreviewToolbar {...DEFAULT_PROPS} onGoToPage={onGoToPage} />);

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(onGoToPage).toHaveBeenCalledWith(3);
  });

  it("disables Next page at the last page", () => {
    render(
      <PdfPreviewToolbar
        {...DEFAULT_PROPS}
        pageNumber={5}
        pageCount={5}
        pageInput="5"
      />,
    );

    expect(
      screen
        .getByRole("button", { name: "Next page" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});
