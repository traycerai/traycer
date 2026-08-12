import { useCallback, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import {
  landingTerminalLayoutFor,
  useLandingTerminalStore,
} from "@/stores/home/landing-terminal-store";
import { useTabsStore } from "@/stores/tabs/store";
import {
  selectHostActiveSurfaceRefs,
  selectHostFocusedRef,
} from "@/stores/tabs/selectors";
import { LandingTerminalPanel } from "./landing-terminal-panel";
import { LandingTerminalGestureProvider } from "./landing-terminal-gesture-provider";

interface LandingPaneAnchorState {
  readonly anchors: ReadonlyMap<string, HTMLElement>;
  readonly setAnchor: (draftId: string, element: HTMLElement | null) => void;
}

/**
 * Ephemeral registry of each visible landing pane's panel slot. Split drafts
 * register one anchor apiece; the single host portals the panel into the
 * selected draft's anchor so the terminal UI stays inside that pane's bounds.
 */
const useLandingPaneAnchorStore = create<LandingPaneAnchorState>()((set) => ({
  anchors: new Map(),
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
  const { draftId } = props;
  const ref = useCallback(
    (element: HTMLDivElement | null) => setAnchor(draftId, element),
    [draftId, setAnchor],
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
 * The one landing-terminal mount for this window. The gesture provider is the
 * single reader of live host/client/folder state and MUST keep its identity
 * while draft focus moves between split panes - it owns the opening-gesture
 * snapshot (captured host/cwd/generation) that reconciliation settles against.
 * Only the panel's presentation moves: it is portaled into the selected
 * draft's registered pane anchor, so the toggle, opened panel, and resize
 * behavior stay confined to that pane while provider state survives the move.
 */
export function LandingTerminalHost() {
  const draftId = useTabsStore((state) => {
    const focused = selectHostFocusedRef(state);
    if (focused?.kind === "draft") return focused.id;
    return (
      selectHostActiveSurfaceRefs(state).find((ref) => ref.kind === "draft")
        ?.id ?? null
    );
  });
  const panelOpen = useLandingTerminalStore((state) =>
    draftId === null
      ? false
      : landingTerminalLayoutFor(state, draftId).panelOpen,
  );
  const anchor = useLandingPaneAnchorStore((state) =>
    draftId === null ? null : (state.anchors.get(draftId) ?? null),
  );

  if (draftId === null && !panelOpen) return null;
  return (
    <LandingTerminalGestureProvider draftId={draftId}>
      {anchor === null ? null : createPortal(<LandingTerminalPanel />, anchor)}
    </LandingTerminalGestureProvider>
  );
}
