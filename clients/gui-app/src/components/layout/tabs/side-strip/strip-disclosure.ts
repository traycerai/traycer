import { useCallback, useEffect } from "react";
import { create } from "zustand";

/**
 * Which tasks the person has expanded or collapsed in the Activity view, kept
 * for the app session and never persisted. A task with no entry follows
 * whether it is the active one.
 */
export const useStripDisclosureStore = create<{
  readonly expanded: Readonly<Record<string, boolean>>;
}>(() => ({ expanded: {} }));

function setExpanded(epicId: string, expanded: boolean): void {
  useStripDisclosureStore.setState((state) => ({
    expanded: { ...state.expanded, [epicId]: expanded },
  }));
}

/**
 * Whether a task's nested agents are showing, and how to change it. The active
 * task always opens expanded: becoming active writes it, so a collapse the
 * person made earlier does not follow them back. Collapsing the task they are
 * on holds until they leave it.
 */
export function useStripTaskExpanded(
  epicId: string | null,
  active: boolean,
): readonly [boolean, (expanded: boolean) => void] {
  const stored = useStripDisclosureStore((state) =>
    epicId !== null && Object.hasOwn(state.expanded, epicId)
      ? state.expanded[epicId]
      : null,
  );
  useEffect(() => {
    if (active && epicId !== null) setExpanded(epicId, true);
  }, [active, epicId]);
  const set = useCallback(
    (expanded: boolean): void => {
      if (epicId !== null) setExpanded(epicId, expanded);
    },
    [epicId],
  );
  return [stored ?? active, set];
}
