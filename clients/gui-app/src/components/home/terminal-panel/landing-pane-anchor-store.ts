import { useLayoutEffect } from "react";
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

/**
 * How much of its start page the RENDERED panel covers: `docked` down the
 * page's right side, or `full` over the whole page (maximized, or any open
 * panel at phone width). A page with no entry shows no panel - it is closed,
 * its target cannot serve one, or another start page hosts the one panel.
 * This is extent, not colour: the panel is canvas from md and `--background`
 * as the phone overlay (`landingTerminalPanelSurfaceClass`).
 */
export type LandingPanelCoverage = "docked" | "full";

export interface LandingPaneAnchorState {
  readonly anchors: ReadonlyMap<string, HTMLElement>;
  readonly presentations: ReadonlyMap<string, LandingPanePresentation>;
  /**
   * What the panel paints on each start page right now, published by the panel
   * itself. A reader that has to match the page's ground (the tab that joins
   * it) reads this and not the stored layout, which outlives the panel: a
   * layout stays open and maximized while nothing is rendered for it.
   */
  readonly panelCoverage: ReadonlyMap<string, LandingPanelCoverage>;
  readonly setAnchor: (draftId: string, element: HTMLElement | null) => void;
  readonly setPresentation: (
    draftId: string,
    presentation: LandingPanePresentation | null,
  ) => void;
  readonly setPanelCoverage: (
    landingPageId: string,
    coverage: LandingPanelCoverage | null,
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
    panelCoverage: new Map(),
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
    setPanelCoverage: (landingPageId, coverage) =>
      set((state) => {
        if (
          state.panelCoverage.get(landingPageId) === (coverage ?? undefined)
        ) {
          return state;
        }
        const panelCoverage = new Map(state.panelCoverage);
        if (coverage === null) {
          panelCoverage.delete(landingPageId);
        } else {
          panelCoverage.set(landingPageId, coverage);
        }
        return { panelCoverage };
      }),
  }),
);

/** What an open panel covers; `null` for a collapsed one, which paints nothing. */
export function landingPanelCoverage(args: {
  readonly panelOpen: boolean;
  readonly fullOverlay: boolean;
}): LandingPanelCoverage | null {
  if (!args.panelOpen) return null;
  return args.fullOverlay ? "full" : "docked";
}

/**
 * Publishes what the panel renders on `landingPageId`, before the paint that
 * shows it, and retracts it when the panel leaves that page. Retraction is its
 * own effect keyed on the page alone, as the anchor's is: a cleanup on the
 * publish effect would drop and re-add the entry on every change of coverage.
 */
export function usePublishLandingPanelCoverage(
  landingPageId: string,
  coverage: LandingPanelCoverage | null,
): void {
  const setPanelCoverage = useLandingPaneAnchorStore(
    (state) => state.setPanelCoverage,
  );
  useLayoutEffect(() => {
    setPanelCoverage(landingPageId, coverage);
  }, [coverage, landingPageId, setPanelCoverage]);
  useLayoutEffect(
    () => () => setPanelCoverage(landingPageId, null),
    [landingPageId, setPanelCoverage],
  );
}

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
