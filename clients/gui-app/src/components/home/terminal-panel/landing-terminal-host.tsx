import { useCallback, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { useTabsStore } from "@/stores/tabs/store";
import {
  selectHostActiveSurfaceRefs,
  selectHostFocusedRef,
} from "@/stores/tabs/selectors";
import { LandingTerminalPanel } from "./landing-terminal-panel";
import { LandingTerminalGestureProvider } from "./landing-terminal-gesture-provider";
import { resolveHostedLandingDraftId } from "./landing-terminal-surface-binding";

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
  const anchor =
    hostedDraftId === null ? null : (anchors.get(hostedDraftId) ?? null);
  return (
    <LandingTerminalGestureProvider draftId={boundDraftId}>
      {anchor === null ? null : createPortal(<LandingTerminalPanel />, anchor)}
    </LandingTerminalGestureProvider>
  );
}
