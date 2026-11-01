import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ActiveTabBody } from "@/components/epic-canvas/canvas/tab-group-view";
import { TabBodySelectedContext } from "@/components/epic-canvas/canvas/tab-body-selected-context";
import { PaneOpener } from "@/components/epic-canvas/canvas/pane-opener";
import { MobileCurrentTileBar } from "@/components/epic-canvas/mobile/mobile-current-tile-bar";
import { MobileTerminalKeyBar } from "@/components/epic-canvas/mobile/mobile-terminal-key-bar";
import { MobileEmptyPaneLevel2 } from "@/components/epic-canvas/mobile/mobile-empty-pane-level2";
import { MobileTabSwitcherMount } from "@/components/epic-canvas/mobile/mobile-tab-switcher-mount";
import { MobileTileColumn } from "@/components/epic-canvas/mobile/mobile-tile-column";
import { MobileTileMenu } from "@/components/epic-canvas/mobile/mobile-tile-menu";
import {
  MobileSecondaryTileClose,
  MobileTileOriginCrumb,
} from "@/components/epic-canvas/mobile/mobile-tile-header-actions";
import type { MobileTileSelection } from "@/components/epic-canvas/mobile/mobile-tile-selection";
import { useMobileTileReading } from "@/components/epic-canvas/mobile/use-mobile-tile-level2-form";
import { resolveHostedTileOwnership } from "@/components/epic-canvas/surface-host/hosted-tile-resolver";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";
import { MobileDrawerTaskPaintReporter } from "@/components/layout/shell/mobile-drawer-history-gate";
import { isEpicArtifactKind } from "@/lib/artifacts/node-display";
import type { MobileTileSlot } from "@/lib/canvas/tile-open/intent";
import { MobileTileOpenTargetContext } from "@/lib/canvas/tile-open/mobile-tile-open-target-context";
import type { MobileLevel2Form } from "@/lib/layout/mobile-layout-form";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import {
  useEpicHostTransportStatus,
  useEpicSnapshotLoaded,
} from "@/lib/epic-selectors";
import { usePublishSurfaceSync } from "@/hooks/sync/use-publish-surface-sync";
import { SURFACE_SYNC_RANK } from "@/stores/sync/surface-sync-store";
import { useStreamSyncingSpell } from "@/hooks/sync/use-stream-syncing-spell";
import { useVirtualKeyboardInset } from "@/hooks/ui/use-virtual-keyboard-inset";
import { useNativeKeyboardOpen } from "@/hooks/ui/use-native-keyboard-open";
import { isMobileApp } from "@/lib/mobile-app";
import { cn } from "@/lib/utils";
import { useEpicCanvas } from "@/stores/epics/canvas/store";
import { firstPaneId } from "@/stores/epics/canvas/tile-tree";
import type { TileLayoutNode } from "@/stores/epics/canvas/types";
import "@/components/layout/shell/mobile-shell-touch-targets.css";

interface MobileEpicTileViewProps {
  readonly epicId: string;
  readonly tabId: string;
}

/**
 * Phone (<768px) epic view: renders one canvas tile, or two side by side where
 * the width rule has room and the person has a second open, in place of the
 * desktop split canvas, with level 2 (the task's tiles) in the form the rule
 * answers. Mounted only from the `useIsMobileViewport()` branch in
 * `TileCanvasLive` (non-null root), so the desktop tiling layer is never built
 * here. The first tile is chosen by `selectMobileTile`, which reads but never
 * writes the split tree; the second is named by its own slot in the same store,
 * off the persisted canvas.
 *
 * Each shown tile renders through the shared `ActiveTabBody` (identical
 * remote-deleted guard + `isActive` derivation as the desktop tab group),
 * wrapped in `TabBodySelectedContext value` because it is a shown surface. Pane
 * visibility still comes from `EpicTabHost`, so a hidden keep-alive epic pane
 * stays non-visible.
 *
 * v1 keep-alive tradeoff (user-approved): only the shown tiles mount, so
 * switching tiles remounts the body - chat scroll position and terminal
 * scrollback reset, though the host PTY session itself survives. A later
 * iteration can mount hidden sibling layers like `TabGroupView` if per-tile
 * view state must persist across switches.
 */
export function MobileEpicTileView(props: MobileEpicTileViewProps) {
  const { epicId, tabId } = props;
  const canvas = useEpicCanvas(tabId);
  const reading = useMobileTileReading(tabId);
  const { level2, primary: selection } = reading;
  // A second tile the width has no room for keeps its slot: it comes back with
  // the width, and the list names it meanwhile.
  const secondary = reading.tiles === 2 ? reading.secondary : null;
  // Which tile the person last touched is the one the epic's focused surface
  // follows; with one tile on screen, it is that one.
  const [engagedSlot, setEngagedSlot] = useState<MobileTileSlot>("primary");
  // The second tile leaving (a rotation, its close) leaves the person in the
  // first, and that does not change when a second tile shows again.
  if (secondary === null && engagedSlot !== "primary") {
    setEngagedSlot("primary");
  }
  useHostedTileEngagement({
    tabId,
    primary: selection,
    secondary,
    onEngage: setEngagedSlot,
  });
  // Must be called before the empty-pane early return (hooks are
  // unconditional); it is 0 everywhere except an overlay-keyboard browser.
  const keyboardInset = useVirtualKeyboardInset();
  // The installed app runs the keyboard in native-resize mode, where the
  // measured inset above is 0 even while the keyboard is up - the plugin-fed
  // native state is the only live "keyboard open" signal there.
  const nativeKeyboardOpen = useNativeKeyboardOpen();
  // The Epic's own leg, RAW. `useEpicConnectionStatus` is a lossy blend of this
  // and the host's cloud link (see `epic-sync-pill-state.ts`), and a cloud-only
  // drop is not this strip's subject: the canvas, the tab list and the sidebar
  // panels are all served by the GUI↔host stream, so that is the one whose
  // absence makes what they are showing stale.
  const epicTransportStatus = useEpicHostTransportStatus();
  const epicSnapshotLoaded = useEpicSnapshotLoaded();
  const paneVisible = usePaneVisible();
  // Before the empty-pane early return, like the insets above: hooks are
  // unconditional, and this one owns a clock that must not be re-timed by a
  // render path changing under it.
  const epicSpell = useStreamSyncingSpell({
    status: epicTransportStatus,
    hasContent: epicSnapshotLoaded,
    identity: epicId,
  });
  // The session's own wake, not the app-wide one - this view always sits under
  // a live session, and the handle is what names this Epic's socket.
  const epicHandle = useMaybeOpenEpicHandle();
  const wakeEpicTransport = useCallback(() => {
    epicHandle?.wakeTransport();
  }, [epicHandle]);
  // REPORTED, not rendered. The one indicator lives in the app shell so it
  // neither moves nor restarts its animation when the surface speaking for it
  // changes; ordering against the session and chat legs is the store's rank.
  usePublishSurfaceSync({
    // Host-scoped: an epic id is host-minted, so the bare id names a different
    // Epic on another machine.
    key: `epic:${epicHandle?.hostId ?? "unresolved"}:${epicId}`,
    rank: SURFACE_SYNC_RANK.epic,
    label: "Task",
    spell: epicSpell,
    wake: epicHandle === null ? null : wakeEpicTransport,
  });

  // Non-null root with no resolvable tile = an empty pane (e.g. the user closed
  // the last tab). Desktop renders the inline `PaneOpener` for this; do the
  // same on mobile instead of a blank dead-end. `PaneOpener` is fully fluid
  // (flex column, no fixed widths), so it is usable at phone width as-is. The
  // switcher mounts alongside it: on an empty pane the list's create row is how
  // the user gets a tab back, so it has to stay reachable.
  if (selection === null) {
    const emptyPanePainted = paneVisible && epicSnapshotLoaded;
    return (
      <>
        <MobileDrawerTaskPaintReporter ready={emptyPanePainted} />
        <MobileEmptyPaneLevel2 epicId={epicId} tabId={tabId}>
          <MobileEmptyEpicPane
            epicId={epicId}
            tabId={tabId}
            root={canvas.root}
          />
        </MobileEmptyPaneLevel2>
      </>
    );
  }

  // Chat and artifact tiles report once their own payload commits; for every
  // other kind the selected tile's chrome is the first content.
  const tileChromePainted =
    paneVisible &&
    epicSnapshotLoaded &&
    selection.ref.type !== "chat" &&
    selection.ref.type !== "published-chat" &&
    !isEpicArtifactKind(selection.ref.type);
  const keyboardOpen = keyboardInset > 0 || nativeKeyboardOpen;

  return (
    // The row is drawn in every form, and the column and the first tile hold
    // their slots in it, so a rotation that changes the form remounts neither.
    <div className="flex h-full min-h-0 w-full bg-canvas">
      <MobileTileColumn epicId={epicId} tabId={tabId} level2={level2} />
      <MobileTilePane
        epicId={epicId}
        tabId={tabId}
        slot="primary"
        selection={selection}
        level2={level2}
        keyboardInset={keyboardInset}
        keyboardOpen={keyboardOpen}
        engaged={secondary === null || engagedSlot === "primary"}
        onEngage={setEngagedSlot}
        trailing={<MobileTileOriginCrumb tabId={tabId} />}
      >
        <MobileDrawerTaskPaintReporter ready={tileChromePainted} />
        {/* No bar here. The Epic's stream reports upward and the app shell renders
          the only one, so a hand-off between surfaces changes what it says
          rather than which element is saying it.

          This view is mounted from `TileCanvasLive`'s `useIsMobileViewport()`
          branch, which a narrow DESKTOP window also satisfies - so publishing
          is not by itself a decision to show anything. Whether a report is
          ever presented is the strip's call, and it gates on `isMobileApp()`
          so the row stays absent on desktop exactly as it always has been. */}
        <MobileTabSwitcherMount epicId={epicId} tabId={tabId} />
      </MobileTilePane>
      {secondary === null ? null : (
        <MobileTilePane
          epicId={epicId}
          tabId={tabId}
          slot="secondary"
          selection={secondary}
          level2={level2}
          keyboardInset={keyboardInset}
          keyboardOpen={keyboardOpen}
          engaged={engagedSlot === "secondary"}
          onEngage={setEngagedSlot}
          trailing={<MobileSecondaryTileClose tabId={tabId} />}
        >
          {null}
        </MobileTilePane>
      )}
    </div>
  );
}

/**
 * A chat paints in the stable surface host, outside its pane in both the DOM and
 * the React tree, so the pane's capture handlers never see it. Both slots can
 * share a pane id, so `claimHostedPaneActivation`'s pane-keyed claim cannot tell
 * them apart either; the record's own instance can. Only while two tiles show:
 * with one, it is the engaged tile whatever is touched.
 */
function useHostedTileEngagement(args: {
  readonly tabId: string;
  readonly primary: MobileTileSelection | null;
  readonly secondary: MobileTileSelection | null;
  readonly onEngage: (slot: MobileTileSlot) => void;
}): void {
  const { tabId, primary, secondary, onEngage } = args;
  const engageFrom = useEffectEvent((target: EventTarget | null) => {
    if (!(target instanceof Element)) return;
    const owner = resolveHostedTileOwnership(target);
    if (owner === null || owner.viewTabId !== tabId) return;
    if (owner.instanceId === primary?.ref.instanceId) onEngage("primary");
    if (owner.instanceId === secondary?.ref.instanceId) onEngage("secondary");
  });
  const twoTiles = secondary !== null;
  useEffect(() => {
    if (!twoTiles) return undefined;
    // What holds focus as two tiles start to show already engaged its tile.
    engageFrom(document.activeElement);
    const listener = (event: Event): void => engageFrom(event.target);
    document.addEventListener("pointerdown", listener, true);
    document.addEventListener("focusin", listener, true);
    return () => {
      document.removeEventListener("pointerdown", listener, true);
      document.removeEventListener("focusin", listener, true);
    };
  }, [twoTiles]);
}

/** What an open from inside each slot's tile lands in: the other one. */
const OTHER_SLOT: Record<MobileTileSlot, MobileTileSlot> = {
  primary: "secondary",
  secondary: "primary",
};

/**
 * One tile on screen: its header, its body and a terminal's key bar. The two
 * panes split the row equally, with nothing to drag.
 */
function MobileTilePane(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly slot: MobileTileSlot;
  readonly selection: MobileTileSelection;
  readonly level2: MobileLevel2Form;
  readonly keyboardInset: number;
  readonly keyboardOpen: boolean;
  readonly engaged: boolean;
  readonly onEngage: (slot: MobileTileSlot) => void;
  readonly trailing: ReactNode;
  readonly children: ReactNode;
}) {
  const { epicId, tabId, slot, selection, level2, engaged, onEngage } = props;
  const { keyboardInset, keyboardOpen, trailing, children } = props;
  const isTerminalTile =
    selection.ref.type === "terminal" ||
    selection.ref.type === "terminal-agent";
  const openTarget = useMemo(
    () => ({ tabId, slot: OTHER_SLOT[slot] }),
    [slot, tabId],
  );
  return (
    <div
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-1 flex-col",
        slot === "secondary" && "border-l border-canvas-border/70",
      )}
      data-testid={
        slot === "primary" ? "mobile-epic-tile-view" : "mobile-epic-second-tile"
      }
      onPointerDownCapture={() => onEngage(slot)}
      onFocusCapture={() => onEngage(slot)}
      // iOS Safari overlays the soft keyboard instead of resizing the page,
      // which would hide the key bar behind it. The measured inset pads the
      // covered strip, lifting the bar to the visible bottom and shrinking
      // the terminal through the normal resize sync. Browser-only: the
      // installed app also overlays (iOS `resize: none`), but there the
      // shell's safe-height tokens already subtract `--keyboard-inset`, so
      // padding here again would double it.
      style={
        !isMobileApp() && isTerminalTile && keyboardInset > 0
          ? { paddingBottom: keyboardInset }
          : undefined
      }
    >
      {children}
      <MobileTileMenu
        epicId={epicId}
        tabId={tabId}
        slot={slot}
        drawn={level2 === "menu"}
      >
        <MobileCurrentTileBar
          epicId={epicId}
          tile={selection.ref}
          level2={level2}
          trailing={trailing}
        />
      </MobileTileMenu>
      <div className="relative min-h-0 flex-1">
        <TabBodySelectedContext.Provider value>
          <MobileTileOpenTargetContext value={openTarget}>
            <ActiveTabBody
              activeTab={selection.ref}
              epicId={epicId}
              groupId={selection.paneId}
              tabId={tabId}
              selected
              // The tile the person is in IS the epic's active surface, so it is
              // globally active (drives focused-composer registration). Unlike
              // desktop it is not gated on `activePaneId`, which can lag the
              // shown tile in the fallback-pane case. This is a pure render prop
              // - no store write - so flipping back to desktop re-derives
              // activation from the real `activePaneId`.
              globallyActive={engaged}
            />
          </MobileTileOpenTargetContext>
        </TabBodySelectedContext.Provider>
      </div>
      {/* Terminal TUIs are driven by keys phone keyboards don't have; the key
        bar injects them. Rendered as a shrink-0 sibling so its height comes
        out of the terminal box above, which drives the existing
        ResizeObserver -> host resize sync automatically. */}
      {isTerminalTile ? (
        <MobileTerminalKeyBar
          instanceId={selection.ref.instanceId}
          keyboardOpen={keyboardOpen}
        />
      ) : null}
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
