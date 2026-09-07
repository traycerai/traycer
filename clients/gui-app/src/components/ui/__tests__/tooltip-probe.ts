import { fireEvent, screen } from "@testing-library/react";

/** A Radix tooltip cannot: its content is portalled and exists only while open. */
export function tooltipTextFor(trigger: Element): string | null {
  // Probing straight after a bare `fireEvent.pointerDown` therefore reports "no tooltip" no matter what is wired
  // up.
  fireEvent.focus(trigger);
  const tip = screen.queryByRole("tooltip");
  const text = tip === null ? null : tip.textContent;
  // Leave the DOM as we found it: an open tooltip is a live `role="tooltip"`
  // node, and a later query in the same test would otherwise find this one too.
  fireEvent.blur(trigger);
  return text;
}

/** `TooltipWrapper` forwards to its child via `asChild`, so the trigger is usually the element a test already
 * has a handle on - but where the wrapper guards a disabled control it sits on an intermediate span instead. */
export function tooltipTextNear(el: Element): string | null {
  const trigger = el.closest('[data-slot="tooltip-trigger"]');
  return trigger === null ? null : tooltipTextFor(trigger);
}

export function anyTooltipHasText(text: string | RegExp): boolean {
  const triggers = document.querySelectorAll('[data-slot="tooltip-trigger"]');
  return [...triggers].some((trigger) => {
    const actual = tooltipTextFor(trigger);
    if (actual === null) return false;
    return typeof text === "string" ? actual === text : text.test(actual);
  });
}
