import { fireEvent, screen } from "@testing-library/react";

/**
 * Read the hover hint attached to `trigger`.
 *
 * Tooltips replaced the app's native `title` attributes, and a `title` could be
 * asserted straight off the DOM node. A Radix tooltip cannot: its content is
 * portalled and exists only while open. This opens it the cheap way - FOCUS,
 * which Radix honours immediately, where pointer-enter sits behind the 500ms
 * open delay and would force every caller onto fake timers.
 *
 * Returns `null` when the trigger carries no tooltip, so "there is no hint
 * here" reads the same way it did against `getAttribute("title")`.
 */
export function tooltipTextFor(trigger: Element): string | null {
  // `fireEvent.focus` is enough: Testing Library dispatches the bubbling
  // `focusin` alongside it (and `focusout` alongside `blur`), which is what
  // React actually delegates `onFocus` from. Firing `focusIn` explicitly as
  // well just delivers React's handler twice.
  //
  // TRAP: Radix's `TooltipTrigger.onFocus` early-returns while its
  // `isPointerDownRef` is set - which stays set until a document `pointerup`.
  // Probing straight after a bare `fireEvent.pointerDown` therefore reports
  // "no tooltip" no matter what is wired up.
  fireEvent.focus(trigger);
  const tip = screen.queryByRole("tooltip");
  const text = tip === null ? null : tip.textContent;
  // Leave the DOM as we found it: an open tooltip is a live `role="tooltip"`
  // node, and a later query in the same test would otherwise find this one too.
  fireEvent.blur(trigger);
  return text;
}

/**
 * The hint on `el` or on the nearest ancestor that is a tooltip trigger.
 *
 * `TooltipWrapper` forwards to its child via `asChild`, so the trigger is
 * usually the element a test already has a handle on - but where the wrapper
 * guards a disabled control it sits on an intermediate span instead, and the
 * caller should not have to know which.
 */
export function tooltipTextNear(el: Element): string | null {
  const trigger = el.closest('[data-slot="tooltip-trigger"]');
  return trigger === null ? null : tooltipTextFor(trigger);
}

/** Whether any tooltip trigger currently rendered carries `text`. */
export function anyTooltipHasText(text: string | RegExp): boolean {
  const triggers = document.querySelectorAll('[data-slot="tooltip-trigger"]');
  return [...triggers].some((trigger) => {
    const actual = tooltipTextFor(trigger);
    if (actual === null) return false;
    return typeof text === "string" ? actual === text : text.test(actual);
  });
}
