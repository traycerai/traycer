import type { CSSProperties, ReactNode } from "react";
import { GitDiffPanelBodyLive } from "@/components/epic-canvas/git-diff/git-diff-panel-body-live";
import { SharingPanel } from "@/components/epic-canvas/panels/epic-sharing/panel";
import { PrPanelBody } from "@/components/epic-canvas/pr/pr-panel-body";
import { FileTreePanelBody } from "@/components/epic-canvas/sidebar/epic-sidebar";

/** The switcher categories whose body is the desktop panel body, unmodified. */
export type SwitcherEmbedCategory =
  | "file-tree"
  | "git-diff"
  | "pull-requests"
  | "sharing";

interface SwitcherPanelEmbedProps {
  readonly category: SwitcherEmbedCategory;
  readonly epicId: string;
  readonly tabId: string;
}

/**
 * The surface these panel bodies are sitting on. The desktop sidebar they were
 * written for is `bg-background`; this sheet is `bg-popover` (`drawer.tsx`), and
 * `@pierre/trees` paints its own background on the list container and every row.
 * Declared here rather than inside the tree, because the SHEET is what knows
 * which surface it is - the tree is mounted on both.
 */
const SWITCHER_EMBED_SURFACE_STYLE = {
  "--pierre-tree-surface": "var(--popover)",
} as CSSProperties;

/**
 * File-tree, Git-diff, Pull-requests and Sharing categories. Unlike the flat
 * lists these are not row-per-item surfaces: they embed the EXACT desktop panel
 * bodies - already click-driven and Pierre-rendered - rather than being rebuilt.
 * All four mount cleanly here: the app-shell `RootDndProvider` supplies the
 * dnd-kit context the file-tree drag bridge needs, and a finger never drags the
 * tree either way: a touch-primary device attaches no pointer listener at all
 * (`useDragSourceDisabled`), and a hybrid one - fine-primary with a touchscreen
 * - keeps the listener but has the touch press vetoed in
 * `EpicCanvasPointerSensor`, so the tree scrolls rather than picking up a row;
 * the canvas-side `SnapshotLoadingProvider` satisfies the
 * file-tree `SnapshotGate`, the PR body's row click opens its detail tile
 * through the same `useEpicTileNavigation` path desktop uses, and the sharing
 * panel reads and writes through the Epic session's host client, which the
 * sheet already sits under. Opening a file / diff / PR tile is detected by the
 * sheet's active-tile watcher, which closes the sheet; in-panel navigation (repo
 * / workspace switch, collapsing a repo group) opens no tile and keeps the sheet
 * open - as does everything in Sharing, which opens no tile at all.
 *
 * Scrolling is per-category: File tree, Git diff and Pull requests each own an
 * internal scroller, while the sharing panel is a plain stack of sections that
 * relies on the desktop sidebar's scroll region, so it is given an equivalent
 * one here.
 *
 * The two Pierre trees need one thing more, because their scroller is inside a
 * SHADOW ROOT. vaul's `shouldDrag` walks up from the touch target looking for a
 * scrolled-away-from-top ancestor, advancing `element.parentNode`; a touch
 * inside a shadow root retargets to the host, so the walk starts outside the
 * shadow tree and can never reach the scroller. It falls through to "nothing
 * scrollable found" and the drawer takes the gesture. Both tree wrappers carry
 * `data-vaul-no-drag`, which short-circuits that decision.
 *
 * This is the DOWNWARD-finger path specifically. An upward finger is
 * `isDraggingInDirection` for a bottom drawer and returns early, before the
 * walk - so that direction never depended on the marker. The flat lists need
 * none of this: their scrollers are ordinary light DOM, so the walk finds them.
 */
export function SwitcherPanelEmbed(props: SwitcherPanelEmbedProps) {
  return (
    <div
      className="min-h-0 flex-1 pb-safe-bottom"
      style={SWITCHER_EMBED_SURFACE_STYLE}
    >
      <SwitcherEmbeddedBody {...props} />
    </div>
  );
}

function SwitcherEmbeddedBody(props: SwitcherPanelEmbedProps): ReactNode {
  const { category, epicId, tabId } = props;
  switch (category) {
    case "file-tree":
      return <FileTreePanelBody epicId={epicId} tabId={tabId} />;
    case "git-diff":
      return <GitDiffPanelBodyLive epicId={epicId} tabId={tabId} />;
    case "pull-requests":
      return <PrPanelBody epicId={epicId} tabId={tabId} />;
    case "sharing":
      return (
        <div className="h-full overflow-y-auto overscroll-contain">
          <SharingPanel epicId={epicId} />
        </div>
      );
  }
}
