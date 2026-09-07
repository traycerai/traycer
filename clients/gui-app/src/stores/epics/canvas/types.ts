import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type { EpicNodeKind } from "@/lib/artifacts/node-display";
import { makeLiteralGuard } from "@/lib/type-guard";
import type { SnapshotSourceBlockIds } from "@/lib/chat/snapshot-source-block-ids";
import type { DesktopJsonValue } from "@/lib/windows/types";
import type { GitStage } from "@traycer/protocol/host";
import type { TuiHarnessId } from "@traycer/protocol/persistence/epic/schemas";
import type { BrowserViewViewportPresetId } from "@traycer-clients/shared/platform/browser-view";
import type {
  EdgeDropPosition,
  SizesByGroupId,
  TileLayoutNode,
} from "./tile-tree";
import {
  TILE_KIND_BLANK,
  TILE_KIND_BROWSER_SESSION,
  TILE_KIND_COMM_GRAPH,
  TILE_KIND_GIT_DIFF,
  TILE_KIND_MANAGED_COMMAND_OUTPUT,
  TILE_KIND_PR_DETAIL,
  TILE_KIND_PR_DIFF,
  TILE_KIND_PUBLISHED_CHAT,
  TILE_KIND_SNAPSHOT_DIFF,
} from "./tile-kinds";

/** Openable node kinds in v1. Subset of `EpicNodeKind` - the sidebar may expose other kinds (e.g. */
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

/** Openable kinds whose tab content is backed by a Y.Doc artifact record. */
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

/**
 * Per-epic remembered PiP position and size. Persisted with the canvas store so geometry survives
 * GUI relaunch; everything else about the PiP is in-memory and resets.
 */
export interface EpicPipGeometry {
  readonly anchorX: number;
  readonly anchorY: number;
  readonly previewWidth: number;
  readonly previewHeight: number;
}

export const WORKSPACE_FILE_TAB_KIND = "workspace-file" as const;
export type WorkspaceFileTabKind = typeof WORKSPACE_FILE_TAB_KIND;
export type OpenableCanvasTabKind = OpenableEpicNodeKind | WorkspaceFileTabKind;
export type TerminalTitleSource = "default" | "manual";

/**
 * Record-backed epic artifact in a tab. Bound to `hostId` for life (read via `useTabHostId()`).
 * `instanceId` is per-tab identity; content `id` is for dedup/rename.
 */
export interface EpicArtifactRef {
  readonly id: string;
  readonly instanceId: string;
  readonly type: RecordBackedEpicNodeKind;
  readonly name: string;
  readonly hostId: string;
  /**
   * Optimistic terminal-agent placeholders can render the provider brand before the durable
   * tui-agent record projects. The persisted record remains the authority once available.
   */
  readonly pendingTuiHarnessId?: TuiHarnessId;
}

export interface LegacyEpicTerminalEvidence {
  readonly name: string;
  readonly titleSource: TerminalTitleSource;
  readonly cwd: string;
  readonly shellCommand?: string;
  readonly shellArgs?: readonly string[];
}

interface EpicTerminalRefBase {
  readonly id: string;
  readonly instanceId: string;
  readonly type: "terminal";
  /** Local presentation fallback only; the capable host owns semantic title. */
  readonly name: string;
  readonly hostId: string;
  /** Who created the session behind this tile. */
  readonly origin?: "shell" | "provider-login" | "setup";
  /** Which provider's sign-in this terminal was opened for. */
  readonly originProviderId?: ProviderId;
  /**
   * Host-authoritative lifetime owner from `terminal.list@2.3`. `manager` means this presentation
   * must stay on the live-session path and never enter `terminal.plain.importLegacy`.
   */
  readonly lifecycleOwner?: "registry" | "manager";
}

/** Renderer-local view pointer to one host-owned epic browser tab. */
export interface BrowserSessionTileRef {
  readonly id: string;
  readonly instanceId: string;
  readonly type: typeof TILE_KIND_BROWSER_SESSION;
  readonly name: string;
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
  readonly viewportPreset: BrowserViewViewportPresetId;
}

/** Pre-migration ref. These semantic fields are import/old-host evidence only. */
export interface LegacyEpicTerminalRef extends EpicTerminalRefBase {
  readonly authority?: undefined;
  readonly titleSource: TerminalTitleSource;
  readonly cwd: string;
}

/**
 * Canonical local presentation pointer. Layout, order, selection and `instanceId` remain
 * renderer-local; terminal semantics resolve through the lifetime `(hostId, id)` binding.
 */
export interface HostEpicTerminalRef extends EpicTerminalRefBase {
  readonly authority: "host";
  readonly legacyFallback: LegacyEpicTerminalEvidence;
  /** Absent by construction; declared only so union consumers can narrow. */
  readonly titleSource?: undefined;
  /** Absent by construction; declared only so union consumers can narrow. */
  readonly cwd?: undefined;
}

/** Presentation-only fallback for an authority discriminator this client does not understand yet. */
export interface UnsupportedEpicTerminalRef extends EpicTerminalRefBase {
  readonly authority: "unsupported";
  readonly rawAuthority: DesktopJsonValue;
  readonly legacyFallback: LegacyEpicTerminalEvidence;
  readonly titleSource?: undefined;
  readonly cwd?: undefined;
}

export type SupportedEpicTerminalRef =
  | LegacyEpicTerminalRef
  | HostEpicTerminalRef;

export type EpicTerminalRef =
  | SupportedEpicTerminalRef
  | UnsupportedEpicTerminalRef;

export function isHostEpicTerminalRef(
  ref: EpicTerminalRef,
): ref is HostEpicTerminalRef {
  return ref.authority === "host";
}

export function isUnsupportedEpicTerminalRef(
  ref: EpicTerminalRef,
): ref is UnsupportedEpicTerminalRef {
  return ref.authority === "unsupported";
}

export function isLegacyEpicTerminalRef(
  ref: EpicTerminalRef,
): ref is LegacyEpicTerminalRef {
  return ref.authority === undefined;
}

/**
 * Host-spawned sessions that must never enter `terminal.plain.importLegacy`.
 * They stay on the legacy tile path even against a capable host.
 */
export function isImportExemptEpicTerminalOrigin(
  origin: EpicTerminalRef["origin"],
): boolean {
  return origin === "provider-login" || origin === "setup";
}

/** Import exemption for one presentation. */
export function isImportExemptEpicTerminalRef(ref: EpicTerminalRef): boolean {
  if (ref.lifecycleOwner === "manager") return true;
  if (ref.lifecycleOwner === "registry") return false;
  return isImportExemptEpicTerminalOrigin(ref.origin);
}

export function existingSessionOriginFields(
  signInProviderId: ProviderId | null,
  setupSession: boolean,
):
  | { readonly origin: "provider-login"; readonly originProviderId: ProviderId }
  | { readonly origin: "setup" }
  | Record<string, never> {
  if (signInProviderId !== null) {
    return {
      origin: "provider-login",
      originProviderId: signInProviderId,
    };
  }
  if (setupSession) {
    return { origin: "setup" };
  }
  return {};
}

export function legacyEpicTerminalEvidence(
  ref: SupportedEpicTerminalRef,
): LegacyEpicTerminalEvidence {
  return isHostEpicTerminalRef(ref)
    ? ref.legacyFallback
    : {
        name: ref.name,
        titleSource: ref.titleSource,
        cwd: ref.cwd,
      };
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
 * Renderer-local file preview tab, bound to the host that produced the tree at open time.
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

/**
 * The PR diff tile's OWN persisted view state, structurally separate from {@link
 * GitDiffTileViewState} on purpose.
 */
export interface PrDiffTileViewState {
  readonly collapsedFileKeys: ReadonlyArray<string>;
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

export interface GitDiffRepositoryContext {
  readonly workspaceLabel: string;
  readonly repositoryLabel: string;
}

export interface SnapshotSegmentDiffTilePayload {
  readonly kind: "snapshot-segment";
  readonly chatId: string;
  readonly sourceBlockIds: SnapshotSourceBlockIds;
  readonly filePath: string;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
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
  | GitDiffFileTilePayload
  | GitDiffBundleTilePayload;

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
  readonly repositoryContext: GitDiffRepositoryContext | null;
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

/** Read-only window on one managed command's log timeline. */
export interface ManagedCommandOutputTileRef {
  readonly id: string;
  readonly instanceId: string;
  readonly type: typeof TILE_KIND_MANAGED_COMMAND_OUTPUT;
  readonly name: string;
  readonly hostId: string;
}

/** Persisted view state of a comm-graph tile: the canvas viewport and which renderer draws it. */
export interface CommGraphTileViewState {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
  readonly mode: "graph" | "office";
}

/** The per-epic communication graph tile. */
export interface CommGraphTileRef {
  readonly id: string;
  readonly instanceId: string;
  readonly type: typeof TILE_KIND_COMM_GRAPH;
  readonly name: string;
  readonly hostId: string;
  readonly epicId: string;
  readonly view: CommGraphTileViewState;
}

/** A chat rendered from the last copy its owning host published. */
export interface PublishedChatTileRef {
  readonly id: string;
  readonly instanceId: string;
  readonly type: typeof TILE_KIND_PUBLISHED_CHAT;
  readonly name: string;
  /** The host serving the cloud read - this tab's own. See above. */
  readonly hostId: string;
  readonly taskId: string;
  readonly chatId: string;
  readonly ownerUserId: string;
  /** The host that owns the chat. Row metadata; nothing is bound to it. */
  readonly ownerHostId: string;
}

/**
 * A blank tab. A real strip tab (titled "New tab", closable) whose body renders the inline opener;
 * picking content replaces it in place.
 */
export interface BlankTileRef {
  readonly id: string;
  readonly instanceId: string;
  readonly type: typeof TILE_KIND_BLANK;
  readonly name: string;
  readonly hostId: string;
}

/** GitHub-style PR full-view tile. */
export interface PrDetailTileRef {
  readonly id: string;
  readonly instanceId: string;
  readonly type: typeof TILE_KIND_PR_DETAIL;
  readonly name: string;
  readonly hostId: string;
  readonly githubHost: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
}

/**
 * The PR's own diff, as a full canvas tile - the same shape as {@link PrDetailTileRef} plus the
 * diff view state, because it is the same identity viewed a different way.
 */
export interface PrDiffTileRef {
  readonly id: string;
  readonly instanceId: string;
  readonly type: typeof TILE_KIND_PR_DIFF;
  readonly name: string;
  readonly hostId: string;
  readonly githubHost: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly view: PrDiffTileViewState;
}

export type EpicCanvasTileRef =
  | EpicNodeRef
  | BrowserSessionTileRef
  | GitDiffTileRef
  | SnapshotDiffTileRef
  | ManagedCommandOutputTileRef
  | CommGraphTileRef
  | PublishedChatTileRef
  | PrDetailTileRef
  | PrDiffTileRef
  | BlankTileRef;

export function isPublishedChatTileRef(
  value: EpicCanvasTileRef,
): value is PublishedChatTileRef {
  return value.type === TILE_KIND_PUBLISHED_CHAT;
}

export function isBlankTileRef(
  value: EpicCanvasTileRef,
): value is BlankTileRef {
  return value.type === TILE_KIND_BLANK;
}

export function isManagedCommandOutputTileRef(
  value: EpicCanvasTileRef,
): value is ManagedCommandOutputTileRef {
  return value.type === TILE_KIND_MANAGED_COMMAND_OUTPUT;
}

export function isCommGraphTileRef(
  value: EpicCanvasTileRef,
): value is CommGraphTileRef {
  return value.type === TILE_KIND_COMM_GRAPH;
}

export function isGitDiffTileRef(
  value: EpicCanvasTileRef,
): value is GitDiffTileRef {
  return value.type === TILE_KIND_GIT_DIFF;
}

export function isBrowserSessionTileRef(
  value: EpicCanvasTileRef,
): value is BrowserSessionTileRef {
  return value.type === TILE_KIND_BROWSER_SESSION;
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

export function isPrDetailTileRef(
  value: EpicCanvasTileRef,
): value is PrDetailTileRef {
  return value.type === TILE_KIND_PR_DETAIL;
}

export function isPrDiffTileRef(
  value: EpicCanvasTileRef,
): value is PrDiffTileRef {
  return value.type === TILE_KIND_PR_DIFF;
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

/** Per-epic canvas snapshot over the N-ary split tree (see `tile-tree.ts`). */
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
 * Consolidated header-tab record for an Epic view. `tabId` is the header-tab identity; `epicId`
 * points at the shared Y.Doc-backed Epic data.
 */
export interface EpicViewTab {
  readonly tabId: string;
  readonly epicId: string;
  readonly name: string;
  readonly surfaceMode?:
    | { readonly kind: "epic" }
    | { readonly kind: "phase-migration"; readonly phaseId: string };
}
