import { Suspense, lazy, useCallback, useEffect, useMemo, useRef } from "react";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { SwitcherCategoryTabs } from "@/components/epic-canvas/mobile/switcher-category-tabs";
import {
  clampToSwitcherCategory,
  isSwitcherCategory,
  visibleSwitcherCategoryDefs,
} from "@/components/epic-canvas/mobile/switcher-categories";
import { SwitcherAgentsList } from "@/components/epic-canvas/mobile/switcher-agents-list";
import { SwitcherTerminalsList } from "@/components/epic-canvas/mobile/switcher-terminals-list";
import { SwitcherBrowsersList } from "@/components/epic-canvas/mobile/switcher-browsers-list";
import { SwitcherArtifactsList } from "@/components/epic-canvas/mobile/switcher-artifacts-list";
import { SwitcherCommentsList } from "@/components/epic-canvas/mobile/switcher-comments-list";
import { SwitcherPrPresenceProbe } from "@/components/epic-canvas/mobile/switcher-pr-presence-probe";
import { selectMobileTile } from "@/components/epic-canvas/mobile/mobile-tile-selection";
import { useEpicCanvas } from "@/stores/epics/canvas/store";
import {
  isGitDiffTileRef,
  isPrDetailTileRef,
  isSnapshotDiffTileRef,
  isWorkspaceFileRef,
  type EpicCanvasTileRef,
} from "@/stores/epics/canvas/types";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { useCanvasHostId } from "@/components/epic-canvas/hooks/use-canvas-host-id";
import { useStreamMethodSupport } from "@/lib/host/stream-runtime-context";
import {
  selectPrScopeHasItems,
  usePrPresenceStore,
} from "@/stores/epics/pr-presence-store";
import { useResolvedTheme } from "@/providers/use-resolved-theme";
import {
  useActiveLeftPanelId,
  useLeftPanelStore,
  type LeftPanelId,
} from "@/stores/epics/left-panel-store";
import { cn } from "@/lib/utils";
import "@/components/layout/shell/mobile-shell-touch-targets.css";

// Lazy so the desktop File-tree / Git-diff / Pull-requests / Sharing bodies -
// and the heavy epic-sidebar module they pull in - load only when a phone user
// opens those categories, and never sit in the mobile tile view's eager module
// graph.
const SwitcherPanelEmbed = lazy(() =>
  import("@/components/epic-canvas/mobile/switcher-panel-embed").then((m) => ({
    default: m.SwitcherPanelEmbed,
  })),
);

interface TabSwitcherSheetProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * "The sheet has not seen a shown tile yet this open." Distinct from `null`,
 * which means it HAS looked and the pane is empty.
 */
const UNOBSERVED = Symbol("unobserved-shown-tile");
type ShownInstanceObservation = string | null | typeof UNOBSERVED;

/** Tile kinds only the embedded File-tree / Git-diff / Pull-requests bodies open. */
function isEmbedOriginatedTileRef(ref: EpicCanvasTileRef): boolean {
  return (
    isWorkspaceFileRef(ref) ||
    isGitDiffTileRef(ref) ||
    isSnapshotDiffTileRef(ref) ||
    isPrDetailTileRef(ref)
  );
}

/**
 * The mobile tab switcher: a drag-dismissable `vaul` bottom sheet whose
 * category bar mirrors the desktop left-panel registry and whose content region
 * shows the active category - the desktop chat tree for Agents, flat lists for
 * Terminals/Browsers/Artifacts, the
 * shared comments panel for Comments, and the embedded desktop File-tree /
 * Git-diff / Pull-requests / Sharing panel bodies for the rest. Creating is a
 * row inside the category that owns the kind, not a sheet-level control.
 *
 * Opened from the mobile header's switcher trigger. Only meaningful on phones -
 * it is mounted from `MobileEpicTileView`, which itself renders only under the
 * `useIsMobileViewport()` canvas branch - and self-gates on `useIsMobileViewport()` as defence.
 */
export function TabSwitcherSheet(props: TabSwitcherSheetProps) {
  const { epicId, tabId, open, onOpenChange } = props;
  const isMobile = useIsMobileViewport();
  // The drawer content is portaled to <body>; re-assert the app's resolved
  // theme on it so `--popover` / `--background` (and the preset tokens) resolve
  // correctly inside the portal instead of falling back to the light :root.
  const { resolvedTheme, themePreset } = useResolvedTheme();
  const persistedCategory = useActiveLeftPanelId(tabId);
  const setActivePanelId = useLeftPanelStore((s) => s.setActivePanelId);
  // The Pull requests category is presence-gated exactly as the desktop rail
  // icon is.
  //
  // Bootstrap contract: this store is a WARM START, never the only answer. It
  // is written by the PR panel body, which on a phone only this category can
  // mount - so read alone it would gate the tab on a cache that only the tab's
  // own hidden child can fill, and an epic whose PRs this device has never
  // seen could never grow the tab. `SwitcherPrPresenceProbe` (mounted below,
  // for as long as the sheet is open) is what actually answers the question;
  // the cache just spares the first frame's latency on repeat opens.
  //
  // The reactive active host is the right scope and not a tab-binding
  // violation: this sheet is an epic-level surface mounted as a SIBLING of the
  // shown tile (`MobileEpicTileView`), so it sits outside every tile's
  // `TabHostProvider` - `useTabHostId()` would throw - exactly like the desktop
  // sidebar that owns the same panels. It also has to match the writer: the
  // panel body and the probe both record under this same host, and a reader on
  // a different scope key could never see what they wrote.
  const activeHostId = useCanvasHostId();
  const hasRecordedPullRequests = usePrPresenceStore(
    selectPrScopeHasItems(activeHostId, epicId),
  );
  // Presence is not sufficient on its own: it is persisted per (host, epic) and
  // outlives the host it was recorded against, so a host that rolls back to a
  // build without the PR stream would still show the tab - and tapping it would
  // land the panel's visible "Update required" surface. On a phone the category
  // simply not being there is the honest answer, matching an epic with no PRs.
  //
  // Only a DEFINITE `unsupported` hides it. Support is client-wide evidence
  // refreshed from any session's handshake manifest and is cleared on every
  // reconnect, so `unknown` (and the `null` of a client that has not been built
  // yet) is a routine transient - treating it as unsupported would blink the tab
  // out and back on each reconnect, which reads as a glitch rather than as a
  // capability. Holding the last good answer through that window is the stable
  // choice, and a wrong hold self-corrects the moment the manifest lands.
  const prStreamSupport = useStreamMethodSupport("pr.subscribeListForEpic");
  const pullRequestsAvailable =
    hasRecordedPullRequests && prStreamSupport !== "unsupported";
  const activeCategory = clampToSwitcherCategory(
    persistedCategory,
    pullRequestsAvailable,
  );

  const handleCategoryChange = useCallback(
    (value: string) => {
      // Persist through the SAME desktop left-panel store so mobile and desktop
      // stay in sync; ignore any value outside the curated set defensively.
      if (isSwitcherCategory(value)) setActivePanelId(tabId, value);
    },
    [setActivePanelId, tabId],
  );

  const handleClose = useCallback(() => onOpenChange(false), [onOpenChange]);

  // Close-on-open for the embedded panel bodies. The row categories close the
  // sheet explicitly - the flat lists own their open call, and the Agents tree
  // closes through its `ChatTreeSurface` - but the File-tree / Git-diff /
  // Pull-requests bodies open a tile through their own internal navigation -
  // which we do not fork - so instead watch the shown tile. Close ONLY when the
  // newly-shown tile is an embed-originated kind (a file-tree tap ->
  // `workspace-file`, a git-diff tap -> `git-diff` / `snapshot-diff`, a PR row
  // tap -> `pr-detail`). A background chat/terminal/artifact open (agent
  // handoff, remote-delete re-resolve, cross-window nav on the shared canvas
  // store) also changes the shown tile, but must NOT close the sheet under the
  // user mid-browse - those row opens close via their own `onClose`.
  const canvas = useEpicCanvas(tabId);
  const shownTile = useMemo(
    () => selectMobileTile(canvas)?.ref ?? null,
    [canvas],
  );
  const shownInstanceId = shownTile?.instanceId ?? null;
  const shownInstanceIdRef = useRef<ShownInstanceObservation>(UNOBSERVED);
  useEffect(() => {
    if (!open) {
      shownInstanceIdRef.current = UNOBSERVED;
      return;
    }
    const previous = shownInstanceIdRef.current;
    shownInstanceIdRef.current = shownInstanceId;
    // Only the FIRST observation of an open sheet is skipped - it establishes
    // the baseline rather than reporting a change. `null` cannot stand for that:
    // it is also a legitimate observation (an empty pane, which is exactly the
    // state the switcher exists to rescue the user from), and conflating the two
    // left the sheet covering the very first tile opened from an empty pane.
    if (previous === UNOBSERVED || shownInstanceId === previous) return;
    if (shownTile !== null && isEmbedOriginatedTileRef(shownTile)) {
      onOpenChange(false);
    }
  }, [open, shownInstanceId, shownTile, onOpenChange]);

  if (!isMobile) return null;

  return (
    <Drawer direction="bottom" open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        data-mobile-shell-touch-scope=""
        data-testid="mobile-tab-switcher-sheet"
        data-theme={themePreset}
        className={cn(resolvedTheme === "dark" && "dark", "h-[70dvh]")}
      >
        {/* Inside the drawer content so it runs only while the sheet is open. */}
        <SwitcherPrPresenceProbe epicId={epicId} hostId={activeHostId} />
        <DrawerHeader className="p-0">
          {/* vaul/Radix requires a title for screen readers; the sheet's own
              content says what it is, so it carries no visible heading. */}
          <DrawerTitle className="sr-only">Switch tab</DrawerTitle>
        </DrawerHeader>
        <Tabs
          value={activeCategory}
          onValueChange={handleCategoryChange}
          className="min-h-0 flex-1 gap-0"
        >
          <div className="shrink-0 border-b border-canvas-border/70">
            <SwitcherCategoryTabs hasPullRequests={pullRequestsAvailable} />
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            {visibleSwitcherCategoryDefs(pullRequestsAvailable).map(
              (definition) => (
                <TabsContent
                  key={definition.id}
                  value={definition.id}
                  className="flex min-h-0 flex-1 flex-col overflow-hidden"
                >
                  <SwitcherCategoryBody
                    categoryId={definition.id}
                    epicId={epicId}
                    tabId={tabId}
                    onClose={handleClose}
                  />
                </TabsContent>
              ),
            )}
          </div>
        </Tabs>
      </DrawerContent>
    </Drawer>
  );
}

interface SwitcherCategoryBodyProps {
  readonly categoryId: LeftPanelId;
  readonly epicId: string;
  readonly tabId: string;
  readonly onClose: () => void;
}

/**
 * Content-region registry: the desktop chat tree for Agents, flat lists for the
 * other row-per-item categories; the shared comments panel for Comments;
 * embedded desktop panel bodies for File tree, Git diff, Pull requests and
 * Sharing. The row categories call `onClose` on selection; the embeds rely on the sheet's active-tile watcher, and the
 * categories that open no tile - Sharing, and Comments, where expanding a thread
 * is reading rather than navigating - simply keep the sheet open.
 */
function SwitcherCategoryBody(props: SwitcherCategoryBodyProps) {
  const { categoryId, epicId, tabId, onClose } = props;
  switch (categoryId) {
    case "chats":
      return (
        <SwitcherAgentsList epicId={epicId} tabId={tabId} onClose={onClose} />
      );
    case "terminals":
      return (
        <SwitcherTerminalsList
          epicId={epicId}
          tabId={tabId}
          onClose={onClose}
        />
      );
    case "browsers":
      return (
        <SwitcherBrowsersList epicId={epicId} tabId={tabId} onClose={onClose} />
      );
    case "artifacts":
      return (
        <SwitcherArtifactsList
          epicId={epicId}
          tabId={tabId}
          onClose={onClose}
        />
      );
    case "comments":
      return <SwitcherCommentsList epicId={epicId} tabId={tabId} />;
    case "file-tree":
      return (
        <Suspense fallback={<SwitcherEmbedFallback />}>
          <SwitcherPanelEmbed
            category="file-tree"
            epicId={epicId}
            tabId={tabId}
          />
        </Suspense>
      );
    case "git-diff":
      return (
        <Suspense fallback={<SwitcherEmbedFallback />}>
          <SwitcherPanelEmbed
            category="git-diff"
            epicId={epicId}
            tabId={tabId}
          />
        </Suspense>
      );
    case "pull-requests":
      return (
        <Suspense fallback={<SwitcherEmbedFallback />}>
          <SwitcherPanelEmbed
            category="pull-requests"
            epicId={epicId}
            tabId={tabId}
          />
        </Suspense>
      );
    case "sharing":
      return (
        <Suspense fallback={<SwitcherEmbedFallback />}>
          <SwitcherPanelEmbed
            category="sharing"
            epicId={epicId}
            tabId={tabId}
          />
        </Suspense>
      );
    default:
      return null;
  }
}

function SwitcherEmbedFallback() {
  return (
    <div className="flex min-h-24 flex-1 items-center justify-center p-6">
      <AgentSpinningDots
        className="size-4 text-muted-foreground"
        testId="switcher-embed-loading"
        variant="dots2"
      />
    </div>
  );
}
