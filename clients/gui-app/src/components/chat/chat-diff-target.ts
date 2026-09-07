import { createContext, use } from "react";
import type { SnapshotSourceBlockIds } from "@/lib/chat/snapshot-source-block-ids";

/** Canvas-neutral click handlers for chat file-change rows. The chat package owns the interaction contract; canvas renderers decide what those clicks actually open. */
export interface DiffRowClickHandlers {
  readonly onClick: () => void;
  readonly onDoubleClick: () => void;
}

export interface ChatSnapshotSegmentDiffRequest {
  readonly filePath: string;
  readonly sourceBlockIds: SnapshotSourceBlockIds;
  /** The row's endpoints AS CLICKED, carried so the tile it opens can still resolve them once the blocks they came from are no longer hydrated. The tile addresses its content by block id and re-reads the blocks from the chat session on every render, which is what lets an in-flight edit's diff update while it streams. */
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
}

export interface ChatSnapshotHashDiffRequest {
  readonly filePath: string;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly title: string | null;
}

export interface ChatSnapshotDiffOpener {
  /** Open one tool-call edit's before->after, keyed by source block ids. */
  readonly segment: (
    request: ChatSnapshotSegmentDiffRequest,
  ) => DiffRowClickHandlers;
  /** Open the chat-level cumulative change for a file. */
  readonly cumulative: (filePath: string) => DiffRowClickHandlers;
  /** Open all currently-listed chat-level cumulative changes. */
  readonly cumulativeBundle: (filePaths: ReadonlyArray<string>) => () => void;
  /** Open a diff addressed directly by a before/after hash pair (artifact `index.md` edits, which have no `file_change` block to resolve from). */
  readonly hash: (request: ChatSnapshotHashDiffRequest) => DiffRowClickHandlers;
}

export const ChatDiffTargetContext =
  createContext<ChatSnapshotDiffOpener | null>(null);

/** Returns openers that mirror the Git file list's interaction: single-click opens a preview tab, double-click pins it. `null` when there is no chat target in context (isolated render / tests) - callers then render the row as non-interactive. */
export function useChatSnapshotDiffOpener(): ChatSnapshotDiffOpener | null {
  return use(ChatDiffTargetContext);
}
