import { useCallback, useEffect, useRef, type RefObject } from "react";

/**
 * Where the keyboard goes after a row the user just removed stops existing.
 *
 * Removing a group or a model filters the focused button's own subtree out of
 * the list. Nothing else claims focus, so the browser drops it on
 * `document.body`: a keyboard user is returned to the top of the page, and a
 * screen-reader user is told nothing at all - after a gesture they made
 * deliberately, on a page where the very next thing they are likely to do is
 * remove the row beside it.
 *
 * A "restore focus" ref does not answer this, because the element that HAD
 * focus is the one that was removed. The target has to be chosen: the row that
 * takes the removed row's place, its neighbour if it was last, and the "Add"
 * control if the list is now empty. That ordering is the caller's - only it
 * knows which rows it has - so this hook takes an ordered list of selectors and
 * takes the first that exists once the removal has rendered.
 *
 * Deliberately selector-based rather than a map of ref callbacks: a per-row ref
 * callback rebuilt each render detaches and reattaches every ref on every
 * keystroke in the row above it, and the thing being looked up here is a DOM
 * node in a subtree this component owns.
 */
export interface RemovalFocusHandoff {
  /** Put on the element enclosing both the rows and the "Add" control. */
  readonly containerRef: RefObject<HTMLDivElement | null>;
  /**
   * Focus the first of these selectors that resolves, once the render that
   * removes the row has committed. Called from the click handler, applied by
   * the effect below - the target does not exist at the moment of the click,
   * and the one that does is about to be destroyed.
   */
  readonly focusAfterRemoval: (selectors: readonly string[]) => void;
}

export function useRemovalFocus(): RemovalFocusHandoff {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pendingRef = useRef<readonly string[] | null>(null);

  const focusAfterRemoval = useCallback(
    (selectors: readonly string[]): void => {
      pendingRef.current = selectors;
    },
    [],
  );

  // No dependency array on purpose. The handoff is armed by an event and has to
  // be honoured by whichever render carries the removal - which is a render of
  // this component with new PROPS, not with new state, so there is no value to
  // list that would identify it. The body is a no-op on every other render.
  useEffect(() => {
    const selectors = pendingRef.current;
    if (selectors === null) return;
    pendingRef.current = null;
    const container = containerRef.current;
    if (container === null) return;
    for (const selector of selectors) {
      const target = container.querySelector(selector);
      if (target instanceof HTMLElement) {
        target.focus();
        return;
      }
    }
  });

  return { containerRef, focusAfterRemoval };
}

/**
 * The attribute a removable row's own control carries, so the handoff above can
 * name its neighbour without holding a reference to it.
 *
 * Attributes rather than `data-testid`s: these are addressed by the component
 * that renders them, and a test id that something also focuses by is a test id
 * that cannot be renamed.
 */
export const FALLBACK_GROUP_DELETE_ATTRIBUTE = "data-fallback-group-delete";
export const FALLBACK_CANDIDATE_REMOVE_ATTRIBUTE =
  "data-fallback-candidate-remove";
export const FALLBACK_ADD_GROUP_ATTRIBUTE = "data-fallback-add-group";
export const FALLBACK_ADD_MODEL_ATTRIBUTE = "data-fallback-add-model";

/**
 * `[attr="value"]`.
 *
 * Unescaped, and safe because the only values ever passed are the draft keys
 * this feature mints itself (`draft-group-7`, `draft-candidate-7`) - never a
 * group NAME, which is user text. Addressing a row by its editable name is the
 * same mistake as keying it by one.
 */
export function focusSelector(attribute: string, draftKey: string): string {
  return `[${attribute}="${draftKey}"]`;
}
