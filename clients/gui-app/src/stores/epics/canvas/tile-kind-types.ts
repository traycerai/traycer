import type {
  BlankTileRef,
  BrowserSessionTileRef,
  CommGraphTileRef,
  EpicArtifactRef,
  EpicTerminalRef,
  GitDiffTileRef,
  ManagedCommandOutputTileRef,
  PrDetailTileRef,
  PrDiffTileRef,
  PublishedChatTileRef,
  SnapshotDiffTileRef,
  WorkspaceFileRef,
} from "./types";
import type { TileKindId } from "./tile-kinds";

/** Maps each tile-kind discriminant to its concrete ref type. */
export interface TileKindToRefMap {
  readonly chat: EpicArtifactRef;
  readonly "terminal-agent": EpicArtifactRef;
  readonly spec: EpicArtifactRef;
  readonly ticket: EpicArtifactRef;
  readonly story: EpicArtifactRef;
  readonly review: EpicArtifactRef;
  readonly terminal: EpicTerminalRef;
  readonly "browser-session": BrowserSessionTileRef;
  readonly "workspace-file": WorkspaceFileRef;
  readonly "git-diff": GitDiffTileRef;
  readonly "snapshot-diff": SnapshotDiffTileRef;
  readonly "managed-command-output": ManagedCommandOutputTileRef;
  readonly "comm-graph": CommGraphTileRef;
  readonly "published-chat": PublishedChatTileRef;
  readonly "pr-detail": PrDetailTileRef;
  readonly "pr-diff": PrDiffTileRef;
  readonly blank: BlankTileRef;
}

export type TileRefFor<K extends TileKindId> = TileKindToRefMap[K];
