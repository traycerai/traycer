import { use, useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { useTabsStore } from "@/stores/tabs/store";
import {
  selectHostActiveSurfaceRefs,
  selectHostFocusedRef,
} from "@/stores/tabs/selectors";
import {
  PaneFocusProbeContext,
  PanePortalContainerContext,
  PaneSurfaceActivityContext,
  PaneVisibilityContext,
  type PaneSurfaceActivity,
} from "@/components/epic-tabs/pane-visibility-context";
import { LandingTerminalPanel } from "./landing-terminal-panel";
import { LandingTerminalGestureProvider } from "./landing-terminal-gesture-provider";
import { resolveHostedLandingDraftId } from "./landing-terminal-surface-binding";

/**
 * The pane context an anchor sits in, captured at the anchor's React position
 * so the portaled panel can be given the same one.
 */
interface LandingPanePresentation {
  readonly activity: PaneSurfaceActivity;
  readonly portalContainer: HTMLElement | null;
  readonly isPaneFocusedNow: () => boolean;
}

interface LandingPaneAnchorState {
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
 */
const useLandingPaneAnchorStore = create<LandingPaneAnchorState>()((set) => ({
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
}));

/**
 * The panel slot a landing draft surface exposes inside its own flex row.
 * `display: contents` keeps the portaled panel participating in the pane's
 * layout exactly as a direct child would.
 */
export function LandingTerminalPaneAnchor(props: {
  readonly draftId: string;
}): ReactNode {
  const setAnchor = useLandingPaneAnchorStore((state) => state.setAnchor);
  const setPresentation = useLandingPaneAnchorStore(
    (state) => state.setPresentation,
  );
  const { draftId } = props;
  // The anchor is the ONE part of this feature that renders in its pane's own
  // React position, so it is also the only place that can read that pane's real
  // presentation. It publishes it for the host to re-provide around the portal.
  const activity = use(PaneSurfaceActivityContext);
  const portalContainer = use(PanePortalContainerContext);
  const isPaneFocusedNow = use(PaneFocusProbeContext);
  const ref = useCallback(
    (element: HTMLDivElement | null) => setAnchor(draftId, element),
    [draftId, setAnchor],
  );
  useEffect(() => {
    setPresentation(draftId, { activity, portalContainer, isPaneFocusedNow });
  }, [activity, draftId, isPaneFocusedNow, portalContainer, setPresentation]);
  // Retraction is its own effect keyed on identity alone: folding it into the
  // publish effect's cleanup would delete and re-add the entry on every pane
  // state change, and the host would portal the panel through a frame of
  // permissive defaults each time - exactly the state this projection exists to
  // prevent.
  useEffect(
    () => () => setPresentation(draftId, null),
    [draftId, setPresentation],
  );
  return (
    <div
      ref={ref}
      className="contents"
      data-testid={`landing-terminal-anchor-${draftId}`}
    />
  );
}

/**
 * Re-provides the hosting pane's context around the portaled panel.
 *
 * `createPortal` moves DOM, not React context: the panel's React parent stays
 * `LandingTerminalHost`, which is a SIBLING of `TopLevelTabHost` and therefore
 * outside every `SurfacePresentationBoundary` (`app-shell.tsx`). Without this
 * bridge the panel reads the permissive context defaults - `visible: true,
 * focused: true` - no matter which pane it is displayed in, or whether that
 * pane is hidden behind another header tab.
 *
 * That is load-bearing now that the panel outlives its page's activation:
 *
 * - `useVisibleTerminalRepair` treats the hidden->visible edge as the ONLY
 *   recovery for a live xterm screen after a `display:none` cycle (it clears the
 *   glyph atlas and refreshes every row). A terminal that never sees the edge
 *   comes back blank or in default colors - the very failure this retention work
 *   exists to remove.
 * - Pane-aware document portals (a terminal tab's context menu) and every focus
 *   grab gate on `usePaneFocused()`, so an unprojected panel would keep them
 *   eligible while sitting behind an epic tab.
 *
 * Mirrors `hosted-chat-surface-context-bridge`, which solves the same
 * displaced-surface problem for hosted chat tiles.
 */
function LandingTerminalPresentationBridge(props: {
  readonly presentation: LandingPanePresentation;
  readonly children: ReactNode;
}): ReactNode {
  const { presentation } = props;
  return (
    <PaneSurfaceActivityContext.Provider value={presentation.activity}>
      <PaneVisibilityContext.Provider value={presentation.activity.visible}>
        <PaneFocusProbeContext.Provider value={presentation.isPaneFocusedNow}>
          <PanePortalContainerContext.Provider
            value={presentation.portalContainer}
          >
            {props.children}
          </PanePortalContainerContext.Provider>
        </PaneFocusProbeContext.Provider>
      </PaneVisibilityContext.Provider>
    </PaneSurfaceActivityContext.Provider>
  );
}

/**
 * The one landing-terminal mount for this window. The gesture provider is the
 * single reader of live host/client/folder state and MUST keep its identity
 * while draft focus moves between split panes - it owns the opening-gesture
 * snapshot (captured host/cwd/generation) that reconciliation settles against.
 * Only the panel's presentation moves: it is portaled into the hosting draft's
 * registered pane anchor, so the toggle, opened panel, and resize behavior stay
 * confined to that pane while provider state survives the move.
 *
 * Existence follows the hosting page's ANCHOR, never the focused tab. Keying it
 * on focus meant every switch to an epic tab unmounted the panel - and with it
 * every terminal tile - so returning re-ran the whole attach (list -> measure ->
 * subscribe -> snapshot replay) behind a "Starting terminal" skeleton, while the
 * live PTYs were pushed into the release-linger pool where the warm cap could
 * evict them outright. The start page itself was mounted the whole time; only
 * the panel was not part of that retained tree.
 *
 * Staying mounted is exactly why the panel's outward-facing behavior (chords,
 * focus grabs) must gate on `useLandingTerminalSurfaceActive()` instead of on
 * being rendered.
 */
export function LandingTerminalHost() {
  const focusedDraftId = useTabsStore((state) => {
    const focused = selectHostFocusedRef(state);
    if (focused?.kind === "draft") return focused.id;
    return (
      selectHostActiveSurfaceRefs(state).find((ref) => ref.kind === "draft")
        ?.id ?? null
    );
  });
  const anchors = useLandingPaneAnchorStore((state) => state.anchors);
  const presentations = useLandingPaneAnchorStore(
    (state) => state.presentations,
  );
  // Guarded adjust-state-during-render (same idiom as the canvas pane
  // keep-alive): the resolution reads its own committed output, so it is a
  // fixed point and converges in one extra pass. A ref read during render would
  // violate the React Compiler's `react-hooks/refs`.
  const [committedHostedDraftId, setCommittedHostedDraftId] = useState<
    string | null
  >(null);
  const hostedDraftId = resolveHostedLandingDraftId({
    focusedDraftId,
    hostedDraftId: committedHostedDraftId,
    anchors,
  });
  if (hostedDraftId !== committedHostedDraftId) {
    setCommittedHostedDraftId(hostedDraftId);
  }

  // The provider is bound to the hosting page, falling back to focus before any
  // anchor has registered (first paint of a start page, and the split-chooser
  // case where the focused side is not a tab). It exists whenever either says a
  // start page is in play - that is the pre-existing contract, and it is what
  // keeps the opening-gesture snapshot alive across an anchor appearing.
  const boundDraftId = hostedDraftId ?? focusedDraftId;
  if (boundDraftId === null) return null;
  // No anchor means no pane to portal into, so the panel itself waits. (Keeping
  // it mounted while its pane is gone - an MRU eviction rather than a tab close
  // - would need a stable container of its own; see the deferred reparenting
  // work.)
  //
  // The panel also waits for that anchor's PRESENTATION, which its publish
  // effect commits one tick after the element registers. Mounting on the
  // element alone would run the panel's first paint - the one that measures the
  // grid and can grab focus - under the permissive context defaults, which is
  // wrong precisely when the hosting pane is not the visible one.
  const anchor =
    hostedDraftId === null ? null : (anchors.get(hostedDraftId) ?? null);
  const presentation =
    hostedDraftId === null ? null : (presentations.get(hostedDraftId) ?? null);
  return (
    <LandingTerminalGestureProvider draftId={boundDraftId}>
      {anchor === null || presentation === null
        ? null
        : createPortal(
            <LandingTerminalPresentationBridge presentation={presentation}>
              <LandingTerminalPanel />
            </LandingTerminalPresentationBridge>,
            anchor,
          )}
    </LandingTerminalGestureProvider>
  );
}
