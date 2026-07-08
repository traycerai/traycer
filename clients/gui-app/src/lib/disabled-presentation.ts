/**
 * Presentation split for a disabled control that must still surface a
 * tooltip. A natively `disabled` button swallows pointer events, so a Radix
 * tooltip anchored on it never opens on hover - the "locked, not hidden"
 * pattern depends on the explanation being reachable. When there is tooltip
 * copy to show, the control disables via `aria-disabled` (the caller blocks
 * activation itself) and styles the disabled look with
 * `ARIA_DISABLED_TRIGGER_CLASS`; native `disabled` is kept only when there is
 * no tooltip to surface (e.g. a brief pending state).
 */
export interface DisabledPresentation {
  readonly ariaDisabled: boolean;
  readonly nativeDisabled: boolean;
}

export function resolveDisabledPresentation(
  disabled: boolean,
  tooltip: string | null,
): DisabledPresentation {
  const ariaDisabled = disabled && tooltip !== null;
  return { ariaDisabled, nativeDisabled: disabled && !ariaDisabled };
}

/** Matches the native disabled look on an `aria-disabled` trigger. */
export const ARIA_DISABLED_TRIGGER_CLASS =
  "aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground";
