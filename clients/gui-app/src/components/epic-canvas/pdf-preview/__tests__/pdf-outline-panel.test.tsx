/**
 * The outline sidebar's contract: top level expanded / deeper levels
 * collapsed by default, expand-on-demand, and every row click handed back
 * to the viewer via `onNavigate` with the exact entry (dest or url intact).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PdfOutlinePanel, type PdfOutlineEntry } from "../pdf-outline-panel";

function entry(
  title: string,
  overrides: Partial<PdfOutlineEntry>,
): PdfOutlineEntry {
  return {
    title,
    dest: `dest:${title}`,
    url: null,
    items: [],
    ...overrides,
  };
}

const OUTLINE: readonly PdfOutlineEntry[] = [
  entry("Chapter 1", {
    items: [
      entry("Reliability", {
        items: [entry("Hardware faults", {})],
      }),
    ],
  }),
  entry("External resource", { dest: null, url: "https://example.com" }),
];

describe("PdfOutlinePanel", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("expands the top level by default and collapses deeper levels", () => {
    render(<PdfOutlinePanel items={OUTLINE} onNavigate={vi.fn()} />);

    expect(screen.getByText("Chapter 1")).toBeTruthy();
    // Depth 1 is visible because its PARENT (depth 0) defaults to expanded.
    expect(screen.getByText("Reliability")).toBeTruthy();
    // Depth 2 stays hidden until "Reliability" is expanded.
    expect(screen.queryByText("Hardware faults")).toBeNull();
  });

  it("expands a collapsed section on demand", () => {
    render(<PdfOutlinePanel items={OUTLINE} onNavigate={vi.fn()} />);

    fireEvent.click(
      screen.getAllByRole("button", { name: "Expand section" })[0],
    );
    expect(screen.getByText("Hardware faults")).toBeTruthy();
  });

  it("hands the clicked entry to onNavigate", () => {
    const onNavigate = vi.fn();
    render(<PdfOutlinePanel items={OUTLINE} onNavigate={onNavigate} />);

    fireEvent.click(screen.getByText("Reliability"));
    expect(onNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Reliability",
        dest: "dest:Reliability",
      }),
    );

    fireEvent.click(screen.getByText("External resource"));
    expect(onNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ dest: null, url: "https://example.com" }),
    );
  });
});
