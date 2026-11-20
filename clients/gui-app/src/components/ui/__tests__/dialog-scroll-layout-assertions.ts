import { expect } from "vitest";

export function expectScrollableDialogLayout(dialog: HTMLElement): Element {
  expect(dialog.classList.contains("flex")).toBe(true);
  expect(dialog.classList.contains("flex-col")).toBe(true);
  expect(dialog.children).toHaveLength(3);

  const header = dialog.children.item(0);
  const body = dialog.children.item(1);
  const footer = dialog.children.item(2);
  if (header === null || body === null || footer === null) {
    throw new Error("Expected dialog header, body, and footer");
  }

  expect(header.classList.contains("shrink-0")).toBe(true);
  expect(body.classList.contains("min-h-0")).toBe(true);
  expect(body.classList.contains("overflow-y-auto")).toBe(true);
  expect(footer.classList.contains("shrink-0")).toBe(true);
  return body;
}

export function expectFocusRingInset(
  scroller: Element,
  insetClasses: readonly string[],
): void {
  for (const className of insetClasses) {
    expect(scroller.classList.contains(className)).toBe(true);
  }
}
