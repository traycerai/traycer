import { useMemo } from "react";
import { ActiveTabBody } from "@/components/epic-canvas/canvas/tab-group-view";
import { TabBodySelectedContext } from "@/components/epic-canvas/canvas/tab-body-selected-context";
import { PaneOpener } from "@/components/epic-canvas/canvas/pane-opener";
import { MobileCurrentTileBar } from "@/components/epic-canvas/mobile/mobile-current-tile-bar";
import { MobileTerminalKeyBar } from "@/components/epic-canvas/mobile/mobile-terminal-key-bar";
import { MobileTabSwitcherMount } from "@/components/epic-canvas/mobile/mobile-tab-switcher-mount";
import { selectMobileTile } from "@/components/epic-canvas/mobile/mobile-tile-selection";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";
import { useVirtualKeyboardInset } from "@/hooks/ui/use-virtual-keyboard-inset";
import { useEpicCanvas } from "@/stores/epics/canvas/store";
import { firstPaneId } from "@/stores/epics/canvas/tile-tree";
import type { TileLayoutNode } from "@/stores/epics/canvas/types";
import "@/components/layout/shell/mobile-shell-touch-targets.css";

interface MobileEpicTileViewProps {
  readonly epicId: string;
  readonly tabId: string;
}

/**
 * Phone (<768px) epic view: renders exactly ONE canvas tile full-screen in
 * place of the desktop split canvas. Mounted only from the `useIsMobileViewport()`
 * branch in `TileCanvasLive` (non-null root), so the desktop tiling layer is
 * never built here. The tile is chosen by {@link selectMobileTile}, which reads
 * but never writes the split tree.
 *
 * The selected tile renders through the shared `ActiveTabBody` (identical
 * remote-deleted guard + `isActive` derivation as the desktop tab group),
 * wrapped in `TabBodySelectedContext value` because it is the one shown
 * surface. Pane visibility still comes from `EpicTabHost`, so a hidden
 * keep-alive epic pane stays non-visible.
 *
 * v1 keep-alive tradeoff (user-approved): only the current tile mounts, so
 * switching tiles remounts the body - chat scroll position and terminal
 * scrollback reset, though the host PTY session itself survives. A later
 * iteration can mount hidden sibling layers like `TabGroupView` if per-tile
 * view state must persist across switches.
 */
export function MobileEpicTileView(props: MobileEpicTileViewProps) {
  const { epicId, tabId } = props;
  const canvas = useEpicCanvas(tabId);
  const selection = useMemo(() => selectMobileTile(canvas), [canvas]);
  // Must be called before the empty-pane early return (hooks are
  // unconditional); it is 0 everywhere except an overlay-keyboard browser.
  const keyboardInset = useVirtualKeyboardInset();

  // Non-null root with no resolvable tile = an empty pane (e.g. the user closed
  // the last tab). Desktop renders the inline `PaneOpener` for this; do the
  // same on mobile instead of a blank dead-end. `PaneOpener` is fully fluid
  // (flex column, no fixed widths), so it is usable at phone width as-is. The
  // switcher mounts alongside it: on an empty pane the sheet's create row is
  // how the user gets a tab back, so the header trigger has to stay live.
  if (selection === null) {
    return (
      <>
        <MobileEmptyEpicPane epicId={epicId} tabId={tabId} root={canvas.root} />
        <MobileTabSwitcherMount epicId={epicId} tabId={tabId} />
      </>
    );
  }

  const isTerminalTile =
    selection.ref.type === "terminal" ||
    selection.ref.type === "terminal-agent";

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col bg-canvas"
      data-testid="mobile-epic-tile-view"
      // iOS Safari overlays the soft keyboard instead of resizing the page,
      // which would hide the key bar behind it. The measured inset pads the
      // covered strip, lifting the bar to the visible bottom and shrinking
      // the terminal through the normal resize sync. Runtime-measured, hence
      // an inline style; 0 (no style) wherever the platform resizes for us.
      style={
        isTerminalTile && keyboardInset > 0
          ? { paddingBottom: keyboardInset }
          : undefined
      }
    >
      <MobileCurrentTileBar epicId={epicId} tile={selection.ref} />
      <div className="relative min-h-0 flex-1">
        <TabBodySelectedContext.Provider value>
          <ActiveTabBody
            activeTab={selection.ref}
            epicId={epicId}
            groupId={selection.paneId}
            tabId={tabId}
            selected
            // The single visible mobile tile IS the epic's active surface, so
            // it is always globally active (drives focused-composer
            // registration). Unlike desktop it is not gated on `activePaneId`,
            // which can lag the shown tile in the fallback-pane case. This is a
            // pure render prop - no store write - so flipping back to desktop
            // re-derives activation from the real `activePaneId`.
            globallyActive
          />
        </TabBodySelectedContext.Provider>
      </div>
      {/* Terminal TUIs are driven by keys phone keyboards don't have; the key
          bar injects them. Rendered as a shrink-0 sibling so its height comes
          out of the terminal box above, which drives the existing
          ResizeObserver -> host resize sync automatically. */}
      {isTerminalTile ? (
        <MobileTerminalKeyBar
          instanceId={selection.ref.instanceId}
          keyboardOpen={keyboardInset > 0}
        />
      ) : null}
      <MobileTabSwitcherMount epicId={epicId} tabId={tabId} />
    </div>
  );
}

interface MobileEmptyEpicPaneProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly root: TileLayoutNode | null;
}

function MobileEmptyEpicPane(props: MobileEmptyEpicPaneProps) {
  const { epicId, tabId, root } = props;
  const paneVisible = usePaneVisible();
  // Defensive: this component is only reached with a non-null root (the mobile
  // branch in TileCanvasLive gates on it), but guard rather than assert.
  if (root === null) return null;
  return (
    <div
      data-mobile-shell-touch-scope=""
      className="flex h-full min-h-0 w-full flex-col bg-canvas"
      data-testid="mobile-epic-empty-pane"
    >
      <PaneOpener
        epicId={epicId}
        tabId={tabId}
        groupId={firstPaneId(root)}
        active={paneVisible}
      />
    </div>
  );
}
