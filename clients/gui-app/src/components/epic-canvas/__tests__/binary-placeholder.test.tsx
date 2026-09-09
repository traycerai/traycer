import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { BinaryPlaceholder } from "../binary-placeholder";

afterEach(() => {
  cleanup();
});

describe("<BinaryPlaceholder />", () => {
  it("uses the compact layout without a heading", () => {
    render(
      <BinaryPlaceholder
        fileName="photo.png"
        sizeBytes={12}
        reason={null}
        onOpenExternally={null}
        openExternallyOpening={false}
        compact
      />,
    );

    expect(screen.queryByText("Binary File")).toBeNull();
    expect(screen.getByText("photo.png")).toBeTruthy();
  });

  // "Binary File" above "This PDF is too large..." reads as a contradiction -
  // the heading names the type the extension already told us.
  it("names a known document format in place of the generic heading", () => {
    render(
      <BinaryPlaceholder
        fileName="report.pdf"
        sizeBytes={12}
        reason="This PDF is too large to preview."
        onOpenExternally={null}
        openExternallyOpening={false}
        compact={false}
      />,
    );

    expect(screen.getByRole("heading", { name: "PDF" })).toBeTruthy();
    expect(screen.queryByText("Binary File")).toBeNull();
  });

  it("names a Word document by its own label", () => {
    render(
      <BinaryPlaceholder
        fileName="brief.docx"
        sizeBytes={12}
        reason="This Word document is too large to preview."
        onOpenExternally={null}
        openExternallyOpening={false}
        compact={false}
      />,
    );

    expect(screen.getByRole("heading", { name: "Word document" })).toBeTruthy();
    expect(screen.queryByText("Binary File")).toBeNull();
  });

  // Legacy `.doc` has no viewer here, so it keeps the generic heading - the
  // one-character gap from `.docx` must not be papered over.
  it("keeps the generic heading for a file with no known format", () => {
    render(
      <BinaryPlaceholder
        fileName="legacy.doc"
        sizeBytes={12}
        reason={null}
        onOpenExternally={null}
        openExternallyOpening={false}
        compact={false}
      />,
    );

    expect(screen.getByRole("heading", { name: "Binary File" })).toBeTruthy();
  });

  it("hides Open Externally when no callback is supplied", () => {
    render(
      <BinaryPlaceholder
        fileName="photo.png"
        sizeBytes={null}
        reason="Preview could not be decoded."
        onOpenExternally={null}
        openExternallyOpening={false}
        compact={false}
      />,
    );

    expect(screen.getByText("Preview could not be decoded.")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Open Externally" }),
    ).toBeNull();
  });

  it("disables Open Externally and shows its spinner while opening", () => {
    const onOpenExternally = vi.fn();

    render(
      <BinaryPlaceholder
        fileName="photo.png"
        sizeBytes={12}
        reason={null}
        onOpenExternally={onOpenExternally}
        openExternallyOpening
        compact={false}
      />,
    );

    expect(
      screen
        .getByRole("button", { name: "Open Externally" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByTestId("binary-open-editor-spinner")).toBeTruthy();
  });
});
