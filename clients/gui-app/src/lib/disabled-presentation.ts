/**
 * Presentation split for a disabled control that must still surface a tooltip.
 * A natively `disabled` button swallows pointer events, so a Radix tooltip anchored on it never opens on hover - the "locked, not hidden" pattern depends on the explanation being reachable.
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
