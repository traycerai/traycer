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
