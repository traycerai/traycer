import { create } from "zustand";
import type { PaneSurfaceActivity } from "@/components/epic-tabs/pane-visibility-context";

/**
 * The pane context an anchor sits in, captured at the anchor's React position
 * so the portaled panel can be given the same one.
 */
export interface LandingPanePresentation {
  readonly activity: PaneSurfaceActivity;
  readonly portalContainer: HTMLElement | null;
  readonly isPaneFocusedNow: () => boolean;
}

export interface LandingPaneAnchorState {
  readonly anchors: ReadonlyMap<string, HTMLElement>;
  readonly presentations: ReadonlyMap<string, LandingPanePresentation>;
  readonly setAnchor: (draftId: string, element: HTMLElement | null) => void;
  readonly setPresentation: (
    draftId: string,
    presentation: LandingPanePresentation | null,
  ) => void;
}

/**
 * Ephemeral registry of each visible landing pane's panel slot. Split drafts
 * register one anchor apiece; the single host portals the panel into the
 * selected draft's anchor so the terminal UI stays inside that pane's bounds.
 *
 * Its own module rather than `landing-terminal-host.tsx` so a non-component
 * caller can read it: the fast-refresh lint rule forbids exporting a plain
 * function or store from a file that exports components.
 */
export const useLandingPaneAnchorStore = create<LandingPaneAnchorState>()(
  (set) => ({
    anchors: new Map(),
    presentations: new Map(),
    setAnchor: (draftId, element) =>
      set((state) => {
        if (state.anchors.get(draftId) === (element ?? undefined)) return state;
        const anchors = new Map(state.anchors);
        if (element === null) {
          anchors.delete(draftId);
        } else {
          anchors.set(draftId, element);
        }
        return { anchors };
      }),
    // Field-wise equality, not reference: this runs on every anchor render, and a
    // fresh map identity would re-render the host (and with it re-run the panel's
    // gates) on every keystroke in the start page.
    setPresentation: (draftId, presentation) =>
      set((state) => {
        const current = state.presentations.get(draftId);
        if (presentation === null) {
          if (current === undefined) return state;
          const presentations = new Map(state.presentations);
          presentations.delete(draftId);
          return { presentations };
        }
        if (
          current !== undefined &&
          current.activity.visible === presentation.activity.visible &&
          current.activity.focused === presentation.activity.focused &&
          current.portalContainer === presentation.portalContainer &&
          current.isPaneFocusedNow === presentation.isPaneFocusedNow
        ) {
          return state;
        }
        const presentations = new Map(state.presentations);
        presentations.set(draftId, presentation);
        return { presentations };
      }),
  }),
);

/**
 * Every start page with a mounted panel slot right now.
 *
 * This is the candidate set the single panel is portaled into:
 * `resolveHostedLandingDraftId` answers with the focused draft, else the
 * retained hosted one, else the first anchor - all of which are members of
 * THIS set (it returns null only when the set is empty). A caller that has to
 * make the panel visible without being able to read the host's retained React
 * state can therefore act on the whole set and be certain the hosted page is
 * covered.
 */
export function landingPaneAnchorDraftIds(): readonly string[] {
  return [...useLandingPaneAnchorStore.getState().anchors.keys()];
}
