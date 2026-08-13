/**
 * Pure state resolution for the stateful scroll-to-end pill (decision log
 * #16). Split from `scroll-to-end-pill.tsx` so the component file only
 * exports the component (Fast Refresh boundary).
 */
export type ScrollToEndPillState =
  | { readonly kind: "hidden" }
  | { readonly kind: "plain" }
  | { readonly kind: "streaming"; readonly workingVerb: string }
  | { readonly kind: "new-reply" };

export function resolveScrollToEndPillState(input: {
  /** Whether the pill's containing surface should show at all - free-
   *  scrolling away from the tail, or anchored to a turn whose content
   *  overflows the usable viewport. */
  readonly visible: boolean;
  /** A turn is actively streaming (the trailing assistant row has no
   *  `completedAt` yet), regardless of the reader's scroll mode. */
  readonly turnRunning: boolean;
  /** A turn completed while the reader was away (not `following-end`) and
   *  they have not yet returned to the tail. */
  readonly unseenCompletion: boolean;
  readonly workingVerb: string;
}): ScrollToEndPillState {
  if (!input.visible) return { kind: "hidden" };
  if (input.turnRunning) {
    return { kind: "streaming", workingVerb: input.workingVerb };
  }
  if (input.unseenCompletion) return { kind: "new-reply" };
  return { kind: "plain" };
}
