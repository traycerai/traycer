import { useCallback, useId, useState } from "react";

export interface InterviewOptionDetailsDisclosure {
  readonly regionId: string;
  readonly expanded: boolean;
  readonly toggle: () => void;
}

/**
 * Per-option disclosure state for the `?` affordance, owned by whichever row
 * component renders it.
 *
 * A Radix tooltip is hover/focus-only BY CONSTRUCTION, so a finger could never
 * reach these strings: the trigger's `pointerMove` returns early on
 * `pointerType === "touch"` - the only open-from-pointer path there is - and
 * the tap's own `pointerdown` sets the flag that suppresses the focus
 * fallback. The `?` had no `onClick` either, so on a phone it was a dead hole
 * in the row that swallowed the tap without selecting the option (it sits at
 * `z-20` over the row's own `absolute inset-0` toggle).
 *
 * So the `?` doubles as a disclosure. This is deliberately NOT gated on
 * `useCoarsePointer()`: hover still previews on a fine pointer, and a click
 * pins the same text inline under the row where it survives a scroll - which
 * is an improvement on a mouse too, and one branch less to keep true.
 *
 * It lives in its own module rather than beside the components that use it
 * because `react-refresh/only-export-components` (warn, `--max-warnings 0`)
 * fails a component file that also exports a function.
 */
export function useInterviewOptionDetailsDisclosure(): InterviewOptionDetailsDisclosure {
  const regionId = useId();
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((open) => !open), []);
  return { regionId, expanded, toggle };
}
