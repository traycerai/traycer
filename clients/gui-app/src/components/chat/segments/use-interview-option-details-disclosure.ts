import { useCallback, useId, useState } from "react";

export interface InterviewOptionDetailsDisclosure {
  readonly regionId: string;
  readonly expanded: boolean;
  readonly toggle: () => void;
}

/**
 * A row's disclosure state for its `?`. A click or tap pins the details
 * inline; hover still previews them through the button's tooltip, which a
 * Radix tooltip can never open from a touch pointer. Not gated on pointer
 * type on purpose - one path to keep true. Own module because
 * `react-refresh/only-export-components` rejects a hook in a component file.
 */
export function useInterviewOptionDetailsDisclosure(): InterviewOptionDetailsDisclosure {
  const regionId = useId();
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((open) => !open), []);
  return { regionId, expanded, toggle };
}
