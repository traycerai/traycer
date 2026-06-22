import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DiffContentLoadingSkeleton } from "../diff-content-loading-skeleton";

describe("DiffContentLoadingSkeleton", () => {
  beforeEach(() => {
    cleanup();
  });

  it("renders split diff placeholder rows", () => {
    render(
      <DiffContentLoadingSkeleton
        mode="split"
        sizing="fill"
        density="full"
        sectionIndex={0}
      />,
    );

    expect(screen.getByTestId("diff-content-loading-skeleton")).toBeDefined();
    expect(
      screen.getByLabelText("Loading diff").getAttribute("aria-busy"),
    ).toBe("true");
  });

  it("renders compact unified diff placeholder rows", () => {
    render(
      <DiffContentLoadingSkeleton
        mode="unified"
        sizing="content"
        density="compact"
        sectionIndex={1}
      />,
    );

    const skeleton = screen.getByTestId("diff-content-loading-skeleton");
    expect(skeleton.className.includes("min-h-48")).toBe(false);
  });
});
