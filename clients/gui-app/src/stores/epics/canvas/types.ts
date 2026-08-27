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

/**
 * Per-epic remembered PiP position and size. Persisted with the canvas
 * store so geometry survives GUI relaunch; everything else about the PiP
 * is in-memory and resets.
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
 * Reference to a record-backed epic artifact as it lives inside a tab.
 * Stored as a flat shape (not a full record) so canvas state stays stable
 * when the underlying Y.Doc projection evolves. Renderer-local terminal and
 * browser tabs use their own ref shapes instead.
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
  /**
   * Optimistic terminal-agent placeholders can render the provider brand before
   * the durable tui-agent record projects. The persisted record remains the
   * authority once available.
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
  /**
   * Who created the session behind this tile. Absent (the overwhelming
   * majority) and `"shell"` both mean the ordinary case: the tile owns the
   * session and may `terminal.create` it if the host has no record - that is
   * how a restart or a reopened epic gets its shell back.
   *
   * `"provider-login"` means the HOST created it, for a provider sign-in. That
   * tile must never create: re-creating the id would spawn a bare shell with
   * none of the provider's spawn env, so the user would face a prompt that
   * cannot sign them in and no error saying why. It renders a retry affordance
   * that re-runs the RPC instead.
   *
   * `"setup"` means the HOST created it for worktree setup. It is not an
   * import candidate (import would persist the setup command as durable
   * launch evidence). Unlike provider-login it may still recreate as an
   * ordinary shell on the legacy tile path.
   *
   * Optional rather than required: making it required would force every
   * existing terminal-ref construction site to state `origin: "shell"` for no
   * behavioural gain, and absent already means the same thing.
   */
  readonly origin?: "shell" | "provider-login" | "setup";
  /**
   * Which provider's sign-in this terminal was opened for. Meaningful only
   * alongside `origin: "provider-login"`, and required for the retry
   * affordance to work at all: restarting a sign-in means calling
   * `providers.startTerminalLogin` again, and only the tile knows which
   * provider it is standing in for.
   */
  readonly originProviderId?: ProviderId;
  /**
   * Host-authoritative lifetime owner from `terminal.list@2.3`. `manager`
   * means this presentation must stay on the live-session path and never
   * enter `terminal.plain.importLegacy`. `registry` is a durable/plain
   * shadow. Absent on pre-v2.3 persisted tiles and on refs that did not
   * come from an updated-host list.
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
 * Canonical local presentation pointer. Layout, order, selection and
 * `instanceId` remain renderer-local; terminal semantics resolve through the
 * lifetime `(hostId, id)` binding. `legacyFallback` is retained solely so a
 * downgraded host can keep the released behavior during the rollout window.
 */
export interface HostEpicTerminalRef extends EpicTerminalRefBase {
  readonly authority: "host";
  readonly legacyFallback: LegacyEpicTerminalEvidence;
  /** Absent by construction; declared only so union consumers can narrow. */
  readonly titleSource?: undefined;
  /** Absent by construction; declared only so union consumers can narrow. */
  readonly cwd?: undefined;
}

/**
 * Presentation-only fallback for an authority discriminator this client does
 * not understand yet. `rawAuthority` is persisted verbatim so a downgrade or
 * later upgrade does not erase the future owner's marker. Current clients may
 * render the local presentation, but must never treat the rollback fields as
 * semantic import/bootstrap/mutation evidence.
 */
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

/**
 * Import exemption for one presentation. Wire `lifecycleOwner` is the
 * authority when present: a manager row stays manager-owned even with an
 * empty origin cache, and a registry row still imports even if a stale
 * setup/provider-login cache would otherwise mark it exempt. Absent
 * lifecycleOwner falls back to origin enrichment for pre-v2.3 tiles.
 */
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

/**
 * The PR diff tile's OWN persisted view state, structurally separate from
 * {@link GitDiffTileViewState} on purpose. Entries are tagged canonical file
 * keys (`prLocalDiffFileKey`: `b:<token>` / `p:<path>`), not bare paths - and
 * the field is a DIFFERENT field, not a reinterpretation of
 * `collapsedFilePaths`, because no value-level rule can tell a legacy bare
 * entry for a file literally named `p:foo` apart from the tagged key of
 * `foo`. The PR tile's codec reads only this field and ignores any legacy
 * `collapsedFilePaths` in a stored record: a one-time collapse-state reset
 * for PR diff tiles, in exchange for keys that cannot alias.
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

/**
 * Read-only window on one managed command's log timeline.
 *
 * A pointer, not a copy: `id` IS the command id (so opening the same command
 * twice focuses the one window, via the canvas's content-id dedup) and
 * `hostId` is the host that owns it. Description, status and the notify flag
 * are deliberately absent - they are live state the owning chat's stream
 * answers, and a window restored days later must not render a description the
 * agent renamed or a status the shell left. `name` is the generic fallback
 * the tab strip shows only until the stream answers.
 */
export interface ManagedCommandOutputTileRef {
  readonly id: string;
  readonly instanceId: string;
  readonly type: typeof TILE_KIND_MANAGED_COMMAND_OUTPUT;
  readonly name: string;
  readonly hostId: string;
}

/**
 * Persisted view state of a comm-graph tile: the canvas viewport ONLY.
 *
 * Node positions are deliberately NOT persisted - the graph is auto-laid-out
 * from the epic's live agent set on every data change, so a stored position
 * would go stale the moment an agent is created, archived, or reparented.
 * Zoom/pan is the user's own framing of that layout and is worth keeping.
 */
export interface CommGraphTileViewState {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

/**
 * The per-epic communication graph tile.
 *
 * Non-record-backed (there is no Y.Doc artifact behind it) with a COMPUTED,
 * epic-scoped id, following the `git-diff` precedent: reopening the graph for
 * the same epic dedups onto the same tile rather than stacking duplicates.
 *
 * NO HOST BINDING. Every other tile kind is bound to one `hostId` for life
 * because its content lives on exactly one host. The communication graph is the
 * exception: an epic's agents can live on several hosts, each holding its own
 * disjoint slice of the event log, so the tile opens one subscription PER host
 * and merges them. `hostId` is therefore the same inert placeholder the blank
 * tile carries (the field is structural - `renderTile` wraps every tile in a
 * `TabHostProvider`) and the tile body must never read `useTabHostId()`.
 */
export interface CommGraphTileRef {
  readonly id: string;
  readonly instanceId: string;
  readonly type: typeof TILE_KIND_COMM_GRAPH;
  readonly name: string;
  readonly hostId: string;
  readonly epicId: string;
  readonly view: CommGraphTileViewState;
}

/**
 * A chat rendered from the last copy its owning host published.
 *
 * ## The identity is the cloud row, not the chat id
 *
 * `chatId` is host-minted and is NOT unique under a task - two hosts can mint
 * the same one, and after a fork they demonstrably do. So this ref carries the
 * whole `(taskId, ownerUserId, chatId)` triple the cloud read is addressed by,
 * and `id` is derived from all three. That is what lets a published copy and a
 * live session sharing a chat id both be open in one tab: `findOpenArtifactInTab`
 * matches on `id` alone, so two rows that differ only in owning host would
 * otherwise resolve to each other's tile.
 *
 * ## `hostId` is the READING host, not the owner
 *
 * The cloud read is a byte pipe: any host the device can reach serves it, which
 * is precisely what makes an offline owner readable at all. So this binds the
 * tab's own host like every other tile - the tab-host-for-life rule is
 * untouched - and `ownerHostId` is carried separately as the thing the locked
 * composer names. Opening this is not "opening a chat on another host"; nothing
 * here is bound to the owner.
 */
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

/**
 * GitHub-style PR full-view tile. Pure ref, `isRecordBacked: false` (same
 * family as `GitDiffTileRef`/`SnapshotDiffTileRef`) - the heavy PR fact is
 * fetched live over `pr.subscribeDetail`, never stored in the tile itself.
 * `githubHost`/`owner`/`repo`/`prNumber` are the PR's base coordinates (only
 * fully-identified rows are tile-able, per the panel's unknown-base rule).
 * `epicId` is deliberately NOT part of the ref: it is resolved from canvas
 * context (`TileRenderArgs.epicId`) at subscribe time, since the ref is a
 * pure GitHub-coordinate identity that must dedupe/reopen the same tile
 * regardless of which epic's panel opened it.
 */
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
 * The PR's own diff, as a full canvas tile - the same shape as
 * {@link PrDetailTileRef} plus the diff view state, because it is the same
 * identity viewed a different way.
 *
 * Deliberately a PURE PR-coordinate ref: no `runningDir`, no base/head OIDs,
 * no ref names. All of those are re-derived from `pr.subscribeDetail` at
 * render time, so a tile reopened a week later diffs the PR as it is NOW
 * rather than replaying a range that has since been rebased away. It also
 * means the host - not the client - stays the only thing that ever turns a
 * `linkGroupKey` into a directory.
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
  readonly surfaceMode?:
    | { readonly kind: "epic" }
    | { readonly kind: "phase-migration"; readonly phaseId: string };
}
