import { useTabsStore, type TabsStoreState } from "@/stores/tabs/store";
import { selectHostFocusedRef } from "@/stores/tabs/selectors";

/** Deliberately not "the focused draft": a start page that is merely retained (backgrounded header tab,
 * unfocused split side) keeps its anchor registered, and the panel must keep living inside it. */
export function resolveHostedLandingDraftId(args: {
  readonly focusedDraftId: string | null;
  readonly hostedDraftId: string | null;
  readonly anchors: ReadonlyMap<string, HTMLElement>;
}): string | null {
  const { anchors, focusedDraftId, hostedDraftId } = args;
  if (focusedDraftId !== null && anchors.has(focusedDraftId)) {
    return focusedDraftId;
  }
  if (hostedDraftId !== null && anchors.has(hostedDraftId)) {
    return hostedDraftId;
  }
  // Neither is mounted (first paint, or the hosting page closed): adopt any
  // retained start page rather than tearing the panel down.
  return anchors.keys().next().value ?? null;
}

/** Any focus grab, and reconciliation settlement's auto-spawn: a terminal created inside a `display:none` pane
 * cannot be measured and would spawn at the 80x24 fallback grid. */
export function selectLandingTerminalSurfaceActive(
  state: TabsStoreState,
): boolean {
  const focused = selectHostFocusedRef(state);
  return focused === null || focused.kind === "draft";
}

/** Reactive {@link selectLandingTerminalSurfaceActive} for the panel's gates. */
export function useLandingTerminalSurfaceActive(): boolean {
  return useTabsStore(selectLandingTerminalSurfaceActive);
}
