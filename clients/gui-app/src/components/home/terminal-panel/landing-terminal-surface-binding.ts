import { useTabsStore, type TabsStoreState } from "@/stores/tabs/store";
import { selectHostFocusedRef } from "@/stores/tabs/selectors";

/**
 * Which start page currently HOSTS the landing terminal panel, given who is
 * focused and which panes are still mounted.
 *
 * Deliberately not "the focused draft": a start page that is merely retained
 * (backgrounded header tab, unfocused split side) keeps its anchor registered,
 * and the panel must keep living inside it. Anchor membership is the mount
 * signal - `LandingTerminalPaneAnchor` registers exactly while its surface is
 * mounted, so it tracks the top-level keep-alive set without reaching into it.
 *
 * Sticky by design: once a page hosts the panel it keeps hosting it until its
 * anchor goes away, so leaving the start page for an epic tab is not a move.
 * Moving the panel is not free - `createPortal` identifies a portal by its
 * container, so retargeting it unmounts and rebuilds the subtree (that is what
 * makes a moved panel rebuild its PTY attachment), which is why this resolves
 * to the SAME anchor for as long as it exists.
 */
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

/**
 * Whether the landing surface is the top-level surface the keyboard is
 * currently aimed at.
 *
 * The landing terminal panel stays MOUNTED while its start page is merely
 * retained (backgrounded behind another header tab, or the unfocused side of a
 * split) — that is what keeps a PTY's scrollback alive across a tab switch.
 * Everything the panel does that reaches OUTSIDE its own box must therefore
 * gate on this instead of on being mounted:
 *
 * - Its dynamic chord registrations (`tab.new`, `tab.close`, `tab.close-all`,
 *   `tab.next`/`tab.prev`, mod-digit switching). `dispatchAction` gives a
 *   dynamic handler absolute precedence over the static one from a single
 *   global slot, so a mounted-but-backgrounded panel would answer the epic
 *   canvas's chords — and, because a registered handler always reports the
 *   chord as handled, a self-no-oping handler would SWALLOW them rather than
 *   fall through. The gate must therefore skip REGISTRATION, not just early-
 *   return inside the handler.
 * - Any focus grab, and (once the reconciliation half lands) auto-spawn: a
 *   terminal created inside a `display:none` pane cannot be measured and would
 *   spawn at the 80x24 fallback grid.
 *
 * Read as "nothing else owns the keyboard", not as "a start page is focused".
 * The two differ where no top-level surface holds focus at all - an empty split
 * slot's chooser, or a window with no tabs yet - and there the panel shadows
 * nobody, which is also what it did before it started outliving activation.
 * Where a surface IS focused the rule is the focused ref, not mere membership
 * in the active item: in a draft|epic split with the epic side focused, the
 * `tab.*` chords belong to the epic canvas.
 */
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
