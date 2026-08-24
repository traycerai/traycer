import type { ReactNode } from "react";
import { GitDiffPanelBodyLive } from "@/components/epic-canvas/git-diff/git-diff-panel-body-live";
import { PrPanelBody } from "@/components/epic-canvas/pr/pr-panel-body";
import { FileTreePanelBody } from "@/components/epic-canvas/sidebar/epic-sidebar";

/** The switcher categories whose body is the desktop panel body, unmodified. */
export type SwitcherEmbedCategory = "file-tree" | "git-diff" | "pull-requests";

interface SwitcherPanelEmbedProps {
  readonly category: SwitcherEmbedCategory;
  readonly epicId: string;
  readonly tabId: string;
}

/**
 * File-tree, Git-diff and Pull-requests categories. Unlike the flat lists these
 * are not row-per-item surfaces: they embed the EXACT desktop panel bodies -
 * already click-driven and Pierre-rendered - rather than being rebuilt. All
 * three mount cleanly here: the app-shell `RootDndProvider` supplies the dnd-kit
 * context the file-tree drag bridge needs (it only activates on pointer drag,
 * never a tap), the canvas-side `SnapshotLoadingProvider` satisfies the
 * file-tree `SnapshotGate`, and the PR body's row click opens its detail tile
 * through the same `useEpicTileNavigation` path desktop uses. Opening a file /
 * diff / PR tile is detected by the sheet's active-tile watcher, which closes
 * the sheet; in-panel navigation (repo / workspace switch, collapsing a repo
 * group) opens no tile and keeps the sheet open.
 */
export function SwitcherPanelEmbed(props: SwitcherPanelEmbedProps) {
  return (
    <div className="min-h-0 flex-1 pb-safe-bottom">
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
  }
}
