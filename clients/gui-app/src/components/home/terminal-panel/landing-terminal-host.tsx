import { use, useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
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
} from "@/components/epic-tabs/pane-visibility-context";
import { LandingTerminalPanel } from "./landing-terminal-panel";
import { LandingTerminalGestureProvider } from "./landing-terminal-gesture-provider";
import { resolveHostedLandingDraftId } from "./landing-terminal-surface-binding";
import {
  useLandingPaneAnchorStore,
  type LandingPanePresentation,
} from "./landing-pane-anchor-store";

/** The panel slot a landing draft surface exposes inside its own flex row. */
export function LandingTerminalPaneAnchor(props: {
  readonly draftId: string;
}): ReactNode {
  const setAnchor = useLandingPaneAnchorStore((state) => state.setAnchor);
  const setPresentation = useLandingPaneAnchorStore(
    (state) => state.setPresentation,
  );
  const { draftId } = props;
  // The anchor is the one part of this feature that renders in its pane's own React position, so it is also the
  // only place that can read that pane's real presentation.
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
  // Retraction is its own effect keyed on identity alone.
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

/** A terminal that never sees the edge comes back blank or in default colors - the very failure this retention
 * work exists to remove. */
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

/** The gesture provider is the single reader of live host/client/folder state and must keep its identity while
 * draft focus moves between split panes. */
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
  // A ref read during render would violate the React Compiler's `react-hooks/refs`.
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

  // It exists whenever either says a start page is in play - that is the pre-existing contract, and it is what
  // keeps the opening-gesture snapshot alive across an anchor appearing.
  const boundDraftId = hostedDraftId ?? focusedDraftId;
  if (boundDraftId === null) return null;
  // (Keeping it mounted while its pane is gone - an mru eviction rather than a tab close.
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
