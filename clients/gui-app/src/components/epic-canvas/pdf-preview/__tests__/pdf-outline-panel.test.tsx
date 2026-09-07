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

    expect(screen.getByRole("button", { name: "Chapter 1" })).toBeTruthy();
    // Depth 1 is visible because its PARENT (depth 0) defaults to expanded.
    expect(screen.getByRole("button", { name: "Reliability" })).toBeTruthy();
    // Depth 2 stays hidden until "Reliability" is expanded.
    expect(
      screen.queryByRole("button", { name: "Hardware faults" }),
    ).toBeNull();
  });

  it("expands a collapsed section on demand", () => {
    render(<PdfOutlinePanel items={OUTLINE} onNavigate={vi.fn()} />);

    fireEvent.click(
      screen.getAllByRole("button", { name: "Expand section" })[0],
    );
    expect(
      screen.getByRole("button", { name: "Hardware faults" }),
    ).toBeTruthy();
  });

  it("hands the clicked entry to onNavigate", () => {
    const onNavigate = vi.fn();
    render(<PdfOutlinePanel items={OUTLINE} onNavigate={onNavigate} />);

    // The click travels with the entry: an external outline link answers to
    // the "Open links" setting, and to the modifiers that override it.
    fireEvent.click(screen.getByRole("button", { name: "Reliability" }));
    expect(onNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Reliability",
        dest: "dest:Reliability",
      }),
      expect.objectContaining({ type: "click" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "External resource" }));
    expect(onNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ dest: null, url: "https://example.com" }),
      expect.objectContaining({ type: "click" }),
    );
  });
});
