import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DiffBundleLoadingSkeleton } from "../diff-bundle-loading-skeleton";

describe("DiffBundleLoadingSkeleton", () => {
  beforeEach(() => {
    cleanup();
  });

  it("renders stacked bundle file section placeholders", () => {
    render(<DiffBundleLoadingSkeleton mode="split" />);

    expect(screen.getByTestId("diff-bundle-loading-skeleton")).toBeDefined();
    expect(screen.getAllByTestId("diff-content-loading-skeleton").length).toBe(
      2,
    );
  });
});
