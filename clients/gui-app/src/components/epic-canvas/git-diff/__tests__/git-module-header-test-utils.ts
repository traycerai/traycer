import { fireEvent, screen } from "@testing-library/react";
import { expect } from "vitest";

export async function expectModuleHeaderTooltip(
  header: HTMLElement,
  expected: string,
): Promise<string> {
  expect(header.getAttribute("title")).toBeNull();
  fireEvent.focus(header);
  try {
    const tooltip = await screen.findByRole("tooltip");
    const tooltipText = tooltip.textContent;
    expect(tooltipText).toContain(expected);
    return tooltipText;
  } finally {
    fireEvent.blur(header);
  }
}
