import type { CSSProperties, ReactNode } from "react";
import { GitDiffPanelBodyLive } from "@/components/epic-canvas/git-diff/git-diff-panel-body-live";
import { SharingPanel } from "@/components/epic-canvas/panels/epic-sharing/panel";
import { PrPanelBody } from "@/components/epic-canvas/pr/pr-panel-body";
import { FileTreePanelBody } from "@/components/epic-canvas/sidebar/epic-sidebar";
import { LinkTargetProvider } from "@/lib/links/link-target-provider";

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
 * Declared here rather than inside the tree, because the SHEET is what knows which surface it is - the tree is mounted on both.
 */
const SWITCHER_EMBED_SURFACE_STYLE = {
  "--pierre-tree-surface": "var(--popover)",
} as CSSProperties;

/**
 * Unlike the row lists these are not row-per-item surfaces: they embed the EXACT desktop panel bodies - already click-driven and Pierre-rendered - rather than being rebuilt.
 * All four mount cleanly here: the app-shell `RootDndProvider` supplies the dnd-kit context the file-tree drag bridge needs, and a finger never drags the tree either way: a touch-primary device attaches no pointer listener at all (`useDragSourceDisabled`), and a hybrid one - fine-primary with a touchscreen - keeps the listener but has the touch press vetoed in `EpicCanvasPointerSensor`, so the tree scrolls rather than picking up a row; the canvas-side `SnapshotLoadingProvider` satisfies the file-tree `SnapshotGate`, the PR body's row click opens its detail tile through the same `useEpicTileNavigation` path desktop uses, and the sharing panel reads and writes through the Epic session's host client, which the sheet already sits under.
 */
export function SwitcherPanelEmbed(props: SwitcherPanelEmbedProps) {
  return (
    <div
      className="min-h-0 flex-1 pb-safe-bottom"
      style={SWITCHER_EMBED_SURFACE_STYLE}
    >
      {/* A5a: same reason as the desktop sidebar - these bodies render outside
          `renderTile`, so they need their own link target to open in-app. */}
      <LinkTargetProvider epicId={props.epicId} viewTabId={props.tabId}>
        <SwitcherEmbeddedBody {...props} />
      </LinkTargetProvider>
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
