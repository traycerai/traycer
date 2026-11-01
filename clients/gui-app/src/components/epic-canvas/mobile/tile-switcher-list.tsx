import {
  Suspense,
  lazy,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { SwitcherCategoryTabs } from "@/components/epic-canvas/mobile/switcher-category-tabs";
import { switcherCategories } from "@/components/epic-canvas/mobile/switcher-categories";
import {
  useLayoutRail,
  usePanelVisibilityOverrides,
} from "@/lib/layout/rail-view";
import { SwitcherAgentsList } from "@/components/epic-canvas/mobile/switcher-agents-list";
import { SwitcherTerminalsList } from "@/components/epic-canvas/mobile/switcher-terminals-list";
import { SwitcherBrowsersList } from "@/components/epic-canvas/mobile/switcher-browsers-list";
import { SwitcherSimulatorsList } from "@/components/epic-canvas/mobile/switcher-simulators-list";
import { SwitcherArtifactsList } from "@/components/epic-canvas/mobile/switcher-artifacts-list";
import { SwitcherCommentsList } from "@/components/epic-canvas/mobile/switcher-comments-list";
import { SwitcherLastTileRow } from "@/components/epic-canvas/mobile/switcher-last-tile-row";
import { useMobileTileReading } from "@/components/epic-canvas/mobile/use-mobile-tile-level2-form";
import { MobileTileOpenTargetContext } from "@/lib/canvas/tile-open/mobile-tile-open-target-context";
import {
  isGitDiffTileRef,
  isPrDetailTileRef,
  isSnapshotDiffTileRef,
  isWorkspaceFileRef,
  type EpicCanvasTileRef,
} from "@/stores/epics/canvas/types";
import {
  useActiveLeftPanelId,
  useLeftPanelStore,
} from "@/stores/epics/left-panel-store";
import { isLeftPanelId, type LeftPanelId } from "@/lib/left-panel-ids";

// Lazy so the desktop File-tree / Git-diff / Pull-requests / Sharing bodies -
// and the heavy epic-sidebar module they pull in - load only when a phone user
// opens those categories, and never sit in the mobile tile view's eager module
// graph.
const SwitcherPanelEmbed = lazy(() =>
  import("@/components/epic-canvas/mobile/switcher-panel-embed").then((m) => ({
    default: m.SwitcherPanelEmbed,
  })),
);

interface TileSwitcherListProps {
  readonly epicId: string;
  readonly tabId: string;
  /**
   * The list's surface gets out of the way of a tile just opened from it: the
   * sheet and the menu close. A column stays where it is and passes a no-op.
   */
  readonly onClose: () => void;
}

/**
 * "The list has not seen a shown tile yet." Distinct from `null`, which means it
 * HAS looked and the pane is empty.
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
 * The task's tiles, by category: a category bar in the desktop rail's panels in
 * the user's rail order (the ones switched off in Settings > Layout behind a
 * trailing More), over the active category - the desktop chat tree for Agents,
 * flat lists for Terminals/Browsers/Artifacts, the shared comments panel for
 * Comments, and the embedded desktop File-tree / Git-diff / Pull-requests /
 * Sharing panel bodies for the rest. Creating is a row inside the category that
 * owns the kind, not a list-level control.
 *
 * It has no box of its own beyond filling its parent, and whichever form level 2
 * takes supplies one: `TabSwitcherSheet`, `MobileTileColumn`, `MobileTileMenu`.
 */
export function TileSwitcherList(props: TileSwitcherListProps) {
  const { epicId, tabId, onClose } = props;
  // Every panel is reachable (a chip or under More), so the rail-shared
  // selection is always one the list can show.
  const activeCategory = useActiveLeftPanelId(tabId);
  const setActivePanelId = useLeftPanelStore((s) => s.setActivePanelId);
  const rail = useLayoutRail();
  const visibilityOverrides = usePanelVisibilityOverrides();
  const categories = useMemo(
    () => switcherCategories(rail, visibilityOverrides),
    [rail, visibilityOverrides],
  );

  const handleCategoryChange = useCallback(
    (value: string) => {
      // Persist through the SAME desktop left-panel store so mobile and desktop
      // stay in sync; ignore any value that is not a panel id defensively.
      if (isLeftPanelId(value)) setActivePanelId(tabId, value);
    },
    [setActivePanelId, tabId],
  );

  // Close-on-open for the embedded panel bodies. The row categories close
  // explicitly - the flat lists own their open call, and the Agents tree closes
  // through its `ChatTreeSurface` - but the File-tree / Git-diff / Pull-requests
  // bodies open a tile through their own internal navigation - which we do not
  // fork - so instead watch the shown tile. Close ONLY when the newly-shown tile
  // is an embed-originated kind (a file-tree tap -> `workspace-file`, a git-diff
  // tap -> `git-diff` / `snapshot-diff`, a PR row tap -> `pr-detail`). A
  // background chat/terminal/artifact open (agent handoff, remote-delete
  // re-resolve, cross-window nav on the shared canvas store) also changes the
  // shown tile, but must NOT close the surface under the user mid-browse - those
  // row opens close via their own `onClose`.
  //
  // The tile this list chooses for: the second slot's menu watches the second.
  const reading = useMobileTileReading(tabId);
  const listsForSecondary =
    use(MobileTileOpenTargetContext)?.slot === "secondary";
  const shownTile =
    (listsForSecondary ? reading.secondary : reading.primary)?.ref ?? null;
  const shownInstanceId = shownTile?.instanceId ?? null;
  const shownInstanceIdRef = useRef<ShownInstanceObservation>(UNOBSERVED);
  useEffect(() => {
    const previous = shownInstanceIdRef.current;
    shownInstanceIdRef.current = shownInstanceId;
    // Only the FIRST observation after mounting is skipped - it establishes the
    // baseline rather than reporting a change. `null` cannot stand for that: it
    // is also a legitimate observation (an empty pane, which is exactly the
    // state the switcher exists to rescue the user from), and conflating the two
    // left the sheet covering the very first tile opened from an empty pane.
    if (previous === UNOBSERVED || shownInstanceId === previous) return;
    if (shownTile !== null && isEmbedOriginatedTileRef(shownTile)) onClose();
  }, [shownInstanceId, shownTile, onClose]);

  return (
    <Tabs
      value={activeCategory}
      onValueChange={handleCategoryChange}
      className="min-h-0 flex-1 gap-0"
    >
      <SwitcherLastTileRow epicId={epicId} tabId={tabId} onClose={onClose} />
      <div className="shrink-0 border-b border-canvas-border/70">
        <SwitcherCategoryTabs
          categories={categories}
          activeCategory={activeCategory}
          onSelect={handleCategoryChange}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {[...categories.bar, ...categories.more].map((definition) => (
          <TabsContent
            key={definition.id}
            value={definition.id}
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
          >
            <SwitcherCategoryBody
              categoryId={definition.id}
              epicId={epicId}
              tabId={tabId}
              onClose={onClose}
            />
          </TabsContent>
        ))}
      </div>
    </Tabs>
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
 * Sharing. The row categories call `onClose` on selection; the embeds rely on the list's
 * active-tile watcher, and the categories that open no tile - Sharing, and
 * Comments, where expanding a thread is reading rather than navigating - simply
 * keep the surface open.
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
    case "simulators":
      return (
        <SwitcherSimulatorsList
          epicId={epicId}
          tabId={tabId}
          onClose={onClose}
        />
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
        className="size-4"
        testId="switcher-embed-loading"
        variant="dots2"
        tone="muted"
      />
    </div>
  );
}
