import type { EpicNodeKind } from "@/lib/artifacts/node-display";
import { makeLiteralGuard } from "@/lib/type-guard";
import type { SnapshotSourceBlockIds } from "@/lib/chat/snapshot-source-block-ids";
import type { GitStage } from "@traycer/protocol/host";
import type {
  EdgeDropPosition,
  SizesByGroupId,
  TileLayoutNode,
} from "./tile-tree";
import {
  TILE_KIND_BLANK,
  TILE_KIND_GIT_DIFF,
  TILE_KIND_SNAPSHOT_DIFF,
} from "./tile-kinds";

/**
 * Openable node kinds in v1. Subset of `EpicNodeKind` - the sidebar may
 * expose other kinds (e.g. "workspace") as grouping nodes, but only
 * these resolve to a tab in the canvas.
 */
export type OpenableEpicNodeKind = Extract<
  EpicNodeKind,
  "chat" | "terminal-agent" | "spec" | "ticket" | "story" | "review"
>;

export const isOpenableEpicNodeKind = makeLiteralGuard<OpenableEpicNodeKind>({
  chat: true,
  "terminal-agent": true,
  spec: true,
  ticket: true,
  story: true,
  review: true,
});

/**
 * Openable kinds whose tab content is backed by a Y.Doc artifact record.
 * Terminals are the exception: a terminal tab is a renderer-local PTY
 * session, so it carries its own ref shape (`EpicTerminalRef`).
 */
export type RecordBackedEpicNodeKind = Exclude<
  OpenableEpicNodeKind,
  "terminal"
>;

export const isRecordBackedEpicNodeKind =
  makeLiteralGuard<RecordBackedEpicNodeKind>({
    chat: true,
    "terminal-agent": true,
    spec: true,
    ticket: true,
    story: true,
    review: true,
  });

export const WORKSPACE_FILE_TAB_KIND = "workspace-file" as const;
export type WorkspaceFileTabKind = typeof WORKSPACE_FILE_TAB_KIND;
export type OpenableCanvasTabKind = OpenableEpicNodeKind | WorkspaceFileTabKind;

/**
 * Reference to a record-backed epic artifact as it lives inside a tab.
 * Stored as a flat shape (not a full record) so canvas state stays stable
 * when the underlying Y.Doc projection evolves. Terminal tabs use
 * `EpicTerminalRef` instead.
 *
 * `hostId` is the host (== device) the artifact lives on. Per
 * CLAUDE.md, chat/terminal artifacts are bound to a host for life;
 * binding is set at open time and survives serialization. Tiles read it
 * via `useTabHostId()` instead of the reactive global.
 *
 * `instanceId` is the per-tab identity (a fresh uuid minted when the tab
 * is opened), decoupled from the content `id`. Tab identity - active /
 * preview selection, React keys, DnD, close / move - keys on
 * `instanceId`; dedup and rename stay keyed on the content `id`. Two tabs
 * may share an `id` (same content) while holding distinct `instanceId`s.
 */
export interface EpicArtifactRef {
  readonly id: string;
  readonly instanceId: string;
  readonly type: RecordBackedEpicNodeKind;
  readonly name: string;
  readonly hostId: string;
}

/**
 * Raw terminal tab. Same host-for-life and `instanceId` semantics as
 * `EpicArtifactRef`, but the content is a renderer-local PTY session, not
 * a Y.Doc record. `cwd` is the concrete working directory requested at
 * `terminal.create`. The PTY is created lazily by the tile and may be
 * re-created when the host has no record of the session (e.g. after a
 * host restart), so `cwd` must persist in the ref rather than live in
 * transient open-time state. A PTY the host reports as `exited` is NOT
 * re-created - the tile closes instead (see `useTerminalTileBootstrap`'s
 * `hostSessionExited` gate).
 */
export interface EpicTerminalRef {
  readonly id: string;
  readonly instanceId: string;
  readonly type: "terminal";
  readonly name: string;
  readonly hostId: string;
  readonly cwd: string;
}

export function makeOpenableNodeRef(args: {
  readonly id: string;
  readonly instanceId: string;
  readonly type: OpenableEpicNodeKind;
  readonly name: string;
  readonly hostId: string;
}): EpicArtifactRef {
  return {
    id: args.id,
    instanceId: args.instanceId,
    type: args.type,
    name: args.name,
    hostId: args.hostId,
  };
}

/**
 * Renderer-local file preview tab. The file is not an epic artifact, but the
 * tab still binds to the host that produced the tree at open time - per
 * CLAUDE.md, "tabs are bound to a host for life". Without the binding,
 * persisted tabs would silently re-resolve against the current default host
 * after a host swap or reload and may show wrong content / 404. `hostId`
 * (== `deviceId`) is the host the file lives on; `workspacePath` and
 * `filePath` are local to that host.
 */
export interface WorkspaceFileRef {
  readonly id: string;
  readonly instanceId: string;
  readonly type: WorkspaceFileTabKind;
  readonly name: string;
  readonly hostId: string;
  readonly workspacePath: string;
  readonly filePath: string;
}

export type EpicNodeRef = EpicArtifactRef | EpicTerminalRef | WorkspaceFileRef;

export type GitDiffBundleGroup = "merge" | "staged" | "changes";

export interface GitDiffTileViewState {
  readonly collapsedFilePaths: ReadonlyArray<string>;
}

export interface GitDiffFileTilePayload {
  readonly kind: "file";
  readonly runningDir: string;
  readonly filePath: string;
  readonly stage: GitStage;
}

export interface GitDiffBundleTilePayload {
  readonly kind: "bundle";
  readonly runningDir: string;
  readonly bundleGroup: GitDiffBundleGroup;
}

/**
 * Snapshot diff payloads address a chat file-edit by reference (not by copying
 * content): the renderer re-reads the agent's `beforeContent`/`afterContent`
 * live from the chat session by `chatId`. Addressing modes:
 *
 * - `snapshot-segment`: one inline tool-call edit, keyed by explicit source
 *   block ids. A merged row carries every source block id, so resolution never
 *   depends on display-id encoding.
 * - `snapshot-cumulative`: the chat-level cumulative (first snapshot ->
 *   current) for a file, keyed by `filePath` - matches the accumulated-changes
 *   panel.
 * - `snapshot-cumulative-bundle`: the current accumulated-changes panel as one
 *   multi-file diff tile, keyed by the file paths that were listed when opened.
 * - `snapshot-hash`: a diff addressed directly by a before/after content-hash
 *   pair, independent of any `file_change` block. Used by artifact `index.md`
 *   edits, which carry their hashes on the `artifact_operation` block (artifacts
 *   have no `file_change` block), so the card / change row can open the same
 *   merged diff full-screen in the canvas.
 */
export interface SnapshotSegmentDiffTilePayload {
  readonly kind: "snapshot-segment";
  readonly chatId: string;
  readonly sourceBlockIds: SnapshotSourceBlockIds;
  readonly filePath: string;
}

export interface SnapshotCumulativeDiffTilePayload {
  readonly kind: "snapshot-cumulative";
  readonly chatId: string;
  readonly filePath: string;
}

export interface SnapshotCumulativeBundleDiffTilePayload {
  readonly kind: "snapshot-cumulative-bundle";
  readonly chatId: string;
  readonly filePaths: ReadonlyArray<string>;
}

export interface SnapshotHashDiffTilePayload {
  readonly kind: "snapshot-hash";
  readonly chatId: string;
  readonly filePath: string;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly title: string | null;
}

export type GitDiffTilePayload =
  GitDiffFileTilePayload | GitDiffBundleTilePayload;

export type SnapshotDiffTilePayload =
  | SnapshotSegmentDiffTilePayload
  | SnapshotCumulativeDiffTilePayload
  | SnapshotCumulativeBundleDiffTilePayload
  | SnapshotHashDiffTilePayload;

export interface GitDiffTileRef {
  readonly id: string;
  readonly instanceId: string;
  readonly type: typeof TILE_KIND_GIT_DIFF;
  readonly name: string;
  readonly hostId: string;
  readonly diff: GitDiffTilePayload;
  readonly view: GitDiffTileViewState;
}

export interface SnapshotDiffTileRef {
  readonly id: string;
  readonly instanceId: string;
  readonly type: typeof TILE_KIND_SNAPSHOT_DIFF;
  readonly name: string;
  readonly hostId: string;
  readonly diff: SnapshotDiffTilePayload;
  readonly view: GitDiffTileViewState;
}

/**
 * A blank tab. A real strip tab (titled "New tab", closable) whose body renders
 * the inline opener; picking content replaces it in place. `hostId` is a
 * placeholder - the opener binds the real default host at create time, and
 * the blank body never reads a per-tab host.
 */
export interface BlankTileRef {
  readonly id: string;
  readonly instanceId: string;
  readonly type: typeof TILE_KIND_BLANK;
  readonly name: string;
  readonly hostId: string;
}

export type EpicCanvasTileRef =
  EpicNodeRef | GitDiffTileRef | SnapshotDiffTileRef | BlankTileRef;

export function isBlankTileRef(
  value: EpicCanvasTileRef,
): value is BlankTileRef {
  return value.type === TILE_KIND_BLANK;
}

export function isGitDiffTileRef(
  value: EpicCanvasTileRef,
): value is GitDiffTileRef {
  return value.type === TILE_KIND_GIT_DIFF;
}

export function isWorkspaceFileRef(
  value: EpicCanvasTileRef,
): value is WorkspaceFileRef {
  return value.type === WORKSPACE_FILE_TAB_KIND;
}

export function isSnapshotDiffTileRef(
  value: EpicCanvasTileRef,
): value is SnapshotDiffTileRef {
  return value.type === TILE_KIND_SNAPSHOT_DIFF;
}

export function isDiffTileRef(
  value: EpicCanvasTileRef,
): value is GitDiffTileRef | SnapshotDiffTileRef {
  return isGitDiffTileRef(value) || isSnapshotDiffTileRef(value);
}

/** Five-zone drop target: the four edge splits plus move-into-pane. */
export type DropPosition = EdgeDropPosition | "center";

export type {
  EdgeDropPosition,
  SplitDirection,
  TileGroup,
  TileLayoutNode,
  TilePane,
  SizesByGroupId,
} from "./tile-tree";

/**
 * Per-epic canvas snapshot over the N-ary split tree (see `tile-tree.ts`).
 *
 * - `root === null` means empty-shell: the canvas surface acts as a single
 *   drop zone seeding a root pane on first drop.
 * - `activePaneId` is the globally-focused pane id; sidebar opens land
 *   here, the active tab inside it gets the top accent indicator.
 * - `tilesByInstanceId` holds every open tab's payload, keyed by the tab's
 *   `instanceId`. The tree itself stores only instanceIds, so tile metadata
 *   churn (rename, diff view state) never produces a new tree object and
 *   layout subscribers don't re-render for it. Invariant: the key set
 *   exactly matches the instanceIds reachable from `root`.
 * - `sizesByGroupId` holds each group's normalized child fractions, kept
 *   out of the tree so a ratio drag commits without touching `root`.
 */
export type TilesByInstanceId = Readonly<
  Record<string, EpicCanvasTileRef | undefined>
>;

export interface EpicCanvasState {
  readonly root: TileLayoutNode | null;
  readonly activePaneId: string | null;
  readonly tilesByInstanceId: TilesByInstanceId;
  readonly sizesByGroupId: SizesByGroupId;
}

/**
 * Consolidated header-tab record for an Epic view. `tabId` is the header-tab
 * identity; `epicId` points at the shared Y.Doc-backed Epic data. The canvas
 * snapshot is stored OUT of this record (in the store's `canvasByTabId` map,
 * keyed by `tabId`) so that canvas mutations don't churn this record's identity
 * - header-strip / command-palette consumers that read only tab metadata must
 * not re-render on every tile open/switch.
 */
export interface EpicViewTab {
  readonly tabId: string;
  readonly epicId: string;
  readonly name: string;
}
