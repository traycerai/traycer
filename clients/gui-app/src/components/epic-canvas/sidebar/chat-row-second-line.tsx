import type { ReactNode } from "react";
import type { EpicNodeKind } from "@/lib/artifacts/node-display";
import { WorktreePrStateIcons } from "@/components/worktree/worktree-pr-state-icons";
import { useChatRowWorktreeMetadata } from "@/components/epic-canvas/sidebar/chat-row-worktree-metadata-context";

/**
 * Row-2 (workspace line) slot for a chat / terminal-agent sidebar row: the
 * primary branch (or folder name for a non-git / local binding), a `+N` badge
 * for the owner's extra directories and owned submodules, and one icon per
 * detected PR.
 *
 * **It reads, it never fetches.** Every value here comes from the epic-wide,
 * per-host batch that `EpicChatWorktreeMetadataProvider` mounts once for the
 * whole tree (`useEpicChatWorktreeMetadataForHost`). That is load-bearing, not
 * incidental: the PR facts behind these icons come from the host's `gh` probe,
 * so a per-row query would multiply the expensive leg by the row count. A row
 * with no batch entry - no binding, an unreachable host, a host still loading -
 * renders `null`, and because a React `null` produces no DOM node the row's
 * flex column is left with a single child and collapses back to one line. That
 * is the whole "no row-2 content → single-row collapse" mechanism; it needs no
 * cooperation from the row scaffold.
 *
 * **Phrasing content only.** This slot mounts in THREE row variants - the
 * display `<button>`, the selection-mode `<label>`, and the rename row - so it
 * is `<span>`-rooted throughout (`<button>` accepts phrasing content only).
 * The PR icons are non-interactive elements with click handlers rather than
 * anchors for the same reason; see `worktree-pr-state-icons.tsx` for why that
 * is the accessible choice here rather than a compromise.
 *
 * `epicId` / `artifactType` stay on the props: the batch is keyed by owner id
 * alone (a uuid, unique across chats and terminal-agents), so this component
 * needs only `nodeId`, but the call sites in the row scaffold pass all three
 * and dropping them would churn code T6 is about to touch.
 */
export interface ChatRowSecondLineProps {
  readonly epicId: string;
  readonly nodeId: string;
  readonly artifactType: EpicNodeKind;
}

export function ChatRowSecondLine(props: ChatRowSecondLineProps): ReactNode {
  const metadata = useChatRowWorktreeMetadata(props.nodeId);
  if (metadata === null) return null;
  return (
    <span
      className="flex min-w-0 items-center gap-1.5 text-ui-xs text-muted-foreground"
      data-testid={`epic-sidebar-row-workspace-${props.nodeId}`}
    >
      <span className="truncate" data-testid="chat-row-workspace-label">
        {metadata.label}
      </span>
      {metadata.extraCount === 0 ? null : (
        <span
          className="shrink-0 rounded-full bg-muted px-1.5 text-muted-foreground"
          data-testid="chat-row-workspace-extra-count"
          title={`${metadata.extraCount} more ${
            metadata.extraCount === 1 ? "workspace" : "workspaces"
          }`}
        >
          +{metadata.extraCount}
        </span>
      )}
      <WorktreePrStateIcons
        references={metadata.prReferences}
        testId="chat-row-pr-icons"
      />
    </span>
  );
}
