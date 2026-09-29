import { fireEvent } from "@testing-library/react";

/**
 * Read the hover hint attached to `trigger`.
 *
 * Tooltips replaced the app's native `title` attributes, and a `title` could be
 * asserted straight off the DOM node. A tooltip cannot: its content is
 * portalled and exists only while open. This opens it the cheap way - FOCUS,
 * which our Tooltip honours immediately (no open delay is applied on focus),
 * where pointer-enter sits behind the Provider's own delay and would force
 * every caller onto fake timers.
 *
 * Looks the content up via `trigger`'s own `aria-describedby` rather than a
 * document-wide `role="tooltip"` search: closing is NOT synchronous with the
 * blur below (our Tooltip defers it, matching the underlying primitive), so a
 * global search could still find an earlier probe's not-yet-closed tooltip.
 * Scoping to this trigger's own description sidesteps that regardless of
 * what else is mid-close elsewhere in the document.
 *
 * Returns `null` when the trigger carries no tooltip, so "there is no hint
 * here" reads the same way it did against `getAttribute("title")`.
 */
export function tooltipTextFor(trigger: Element): string | null {
  // `fireEvent.focus` is enough: Testing Library dispatches the bubbling
  // `focusin` alongside it (and `focusout` alongside `blur`), which is what
  // React actually delegates `onFocus` from. Firing `focusIn` explicitly as
  // well just delivers React's handler twice.
  fireEvent.focus(trigger);
  const describedBy = trigger.getAttribute("aria-describedby");
  const ids =
    describedBy === null ? [] : describedBy.split(/\s+/).filter(Boolean);
  const tip =
    ids
      .map((id) => document.getElementById(id))
      .find((el) => el?.getAttribute("role") === "tooltip") ?? null;
  const text = tip === null ? null : tip.textContent;
  // Not synchronous (see above), but still worth firing: it starts the real
  // close instead of leaving the trigger stuck focused for whatever runs next.
  fireEvent.blur(trigger);
  return text;
}

/**
 * The hint on `el` or on the nearest ancestor that is a tooltip trigger.
 *
 * `TooltipWrapper` forwards to its child via `render`, so the trigger is
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
