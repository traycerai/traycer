import type {
  BlankTileRef,
  EpicArtifactRef,
  EpicTerminalRef,
  GitDiffTileRef,
  SnapshotDiffTileRef,
  WorkspaceFileRef,
} from "./types";
import type { TileKindId } from "./tile-kinds";

/**
 * Maps each tile-kind discriminant to its concrete ref type. The schema
 * and render registries are typed `{ [K in TileKindId]: ...<TileKindToRefMap[K]> }`
 * so every kind is registered with handlers typed against its own ref -
 * a git-diff renderer receives `GitDiffTileRef`, a chat renderer receives
 * `EpicArtifactRef` - with no casts and compile-time exhaustiveness. A
 * missing or extra key fails the registry assignment.
 */
export interface TileKindToRefMap {
  readonly chat: EpicArtifactRef;
  readonly "terminal-agent": EpicArtifactRef;
  readonly spec: EpicArtifactRef;
  readonly ticket: EpicArtifactRef;
  readonly story: EpicArtifactRef;
  readonly review: EpicArtifactRef;
  readonly terminal: EpicTerminalRef;
  readonly "workspace-file": WorkspaceFileRef;
  readonly "git-diff": GitDiffTileRef;
  readonly "snapshot-diff": SnapshotDiffTileRef;
  readonly blank: BlankTileRef;
}

export type TileRefFor<K extends TileKindId> = TileKindToRefMap[K];
