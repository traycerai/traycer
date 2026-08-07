import { GitDiffPanelBodyLive } from "@/components/epic-canvas/git-diff/git-diff-panel-body-live";
import { FileTreePanelBody } from "@/components/epic-canvas/sidebar/epic-sidebar";

/**
 * File-tree and Git-diff categories. Unlike the flat lists these are not
 * row-per-item surfaces (research §B): they embed the EXACT desktop panel
 * bodies - already click-driven and Pierre-rendered - rather than being
 * rebuilt. Both bodies mount cleanly here: the app-shell `RootDndProvider`
 * supplies the dnd-kit context the file-tree drag bridge needs (it only
 * activates on pointer drag, never a tap), and the canvas-side
 * `SnapshotLoadingProvider` satisfies the file-tree `SnapshotGate`. Opening a
 * file / diff tile is detected by the sheet's active-tile watcher, which closes
 * the sheet; in-panel navigation (repo / workspace switch) opens no tile and
 * keeps the sheet open.
 */
export function SwitcherPanelEmbed(props: {
  readonly category: "file-tree" | "git-diff";
  readonly epicId: string;
  readonly tabId: string;
}) {
  const { category, epicId, tabId } = props;
  return (
    <div className="min-h-0 flex-1 pb-[env(safe-area-inset-bottom)]">
      {category === "file-tree" ? (
        <FileTreePanelBody epicId={epicId} tabId={tabId} />
      ) : (
        <GitDiffPanelBodyLive epicId={epicId} tabId={tabId} />
      )}
    </div>
  );
}
