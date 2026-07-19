import {
  fireEvent,
  screen,
  waitForElementToBeRemoved,
} from "@testing-library/react";
import { expect } from "vitest";

export async function expectModuleHeaderPreview(
  header: HTMLElement,
  expected: string,
): Promise<string> {
  expect(header.getAttribute("title")).toBeNull();
  fireEvent.focus(header);
  try {
    const preview = await screen.findByTestId(
      "git-module-header-preview-content",
    );
    const surface = preview.closest<HTMLElement>(
      '[data-slot="hover-card-content"]',
    );
    if (surface === null)
      throw new Error("Module header preview did not render");
    const surfaceClasses = surface.className.split(/\s+/);
    expect(surfaceClasses).toContain("overflow-hidden");
    expect(surfaceClasses).toContain("bg-popover");
    expect(surfaceClasses).toContain("text-popover-foreground");
    expect(surfaceClasses).not.toContain("bg-foreground");
    expect(surfaceClasses).not.toContain("text-background");
    preview.querySelectorAll("dd").forEach((rowValue) => {
      expect(rowValue.className.split(/\s+/)).toContain("truncate");
    });
    const previewText = preview.textContent;
    expect(previewText).toContain(expected);
    return previewText;
  } finally {
    fireEvent.blur(header);
    await waitForElementToBeRemoved(() =>
      screen.queryByTestId("git-module-header-preview-content"),
    );
  }
}
