/**
 * Canonical selector + hook surface over the per-Epic projected slices
 * owned by `OpenEpicStore`. This is the single import path for component
 * code - there is no separate compatibility shim.
 *
 * Patterns:
 *   - Plain scalar / single slot: prefer `useEpicStore(s => s.x.byId[id])`
 *     directly. Identity stability of projector slots gives `Object.is`
 *     skip-render automatically.
 *   - Object-shaped selects: wrap with `useShallow` from
 *     `zustand/react/shallow`.
 *   - Derived / cross-slice computations: define at module scope here via
 *     `createSelector(...)` so the cache survives across re-renders.
 *   - Per-id factory selectors: pair with `useMemo([id])` in the caller
 *     so the cache key is stable.
 *
 * Index access discipline: this codebase has `noUncheckedIndexedAccess`
 * off, so `Record<string, X>[key]` is typed as `X`. Use
 * `Object.hasOwn(byId, id) ? byId[id] : null` instead of `byId[id] ?? null`
 * to satisfy `@typescript-eslint/no-unnecessary-condition` while keeping
 * runtime safety.
 */
import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { createSelector, lruMemoize } from "reselect";
import { v4 as uuidv4 } from "uuid";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { artifactFolderChain } from "@/lib/artifacts/artifact-folder-chain";
import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";
import type { RoleClaim } from "@traycer/protocol/persistence/epic/role-claims";
import type {
  GuiHarnessId,
  TuiHarnessId,
} from "@traycer/protocol/persistence/epic/schemas";
import type { ChatRecordRemovalReason } from "@traycer/protocol/host/epic/chat-records";
import type { WorktreeBindingOwnerKind } from "@traycer/protocol/host/worktree-schemas";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type {
  EpicCloudFreshness,
  EpicCloudFreshnessState,
  EpicDurabilityStatusV15,
  EpicLocalProtection,
} from "@traycer/protocol/host/epic/subscribe";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { displayTitle } from "@/lib/display-title";
import { managedCommandTitle } from "@/lib/managed-commands/managed-command-copy";
import { useManagedCommandOnHost } from "@/stores/managed-commands/managed-commands-for-chat";
import {
  deriveEpicSyncPillState,
  type EpicHostDirtyState,
  type EpicSyncPillState,
} from "@/lib/epic-sync-pill-state";
import {
  agentActivityTiers,
  type AgentActivityTier,
} from "@/lib/agent-activity";
import { useEpicAgentActivity } from "@/stores/agent-activity-store";
import { useEpicStore, useMaybeEpicStore } from "@/hooks/use-epic-store";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { useTerminalDisplayTitle } from "@/hooks/terminal/use-terminal-display-title";
import { useAgentRolesEnabled } from "@/hooks/runner/use-runner-feature-settings-query";
import {
  useMaybeOpenEpicHandle,
  useOpenEpicHandle,
} from "@/providers/use-open-epic-handle";
import {
  getEpicSessionHandleHostId,
  getOpenEpicRegistry,
} from "@/lib/registries/epic-session-registry";
import {
  pendingTitleVisibleAutoPurge,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
import {
  isOpenableEpicNodeKind,
  type EpicNodeRef,
} from "@/stores/epics/canvas/types";
import type {
  EpicMigrationSlice,
  OpenEpicState,
  OpenEpicStoreHandle,
  SnapshotFetchError,
} from "@/stores/epics/open-epic/store";
import type { OpenEpicSessionRegistry } from "@/stores/epics/open-epic/session-registry";
import type {
  ArtifactProjection,
  ArtifactsSlice,
  ChatProjection,
  ChatsSlice,
  DeletedArtifactProjection,
  EpicArtifactRoomAvailability,
  EpicTreeNodeType,
  TuiAgentProjection,
  TreeNode,
  TreeSlice,
} from "@/stores/epics/open-epic/types";
import { EMPTY_ARRAY } from "@/stores/epics/open-epic/types";

// ─── Type re-exports ──────────────────────────────────────────────────────

export type EpicArtifactProjection = ArtifactProjection;
export type EpicDeletedArtifactProjection = DeletedArtifactProjection;
export type EpicChatProjection = ChatProjection;
export type EpicTuiAgentProjection = TuiAgentProjection;
export type EpicTreeIndex = TreeSlice;
export type EpicTreeNode = TreeNode;
export type { EpicTreeNodeType };

/**
 * Sidebar-friendly node row that merges artifacts + chats into one
 * sequence. `name` falls back to `Untitled <kind>` so the sidebar always
 * has a label. Identity-stable via `recordForArtifact` / `recordForChat`
 * caches keyed by source projection identity.
 *
 * `hostId` is the host hosting the artifact (per CLAUDE.md
 * tab-bound-to-host-for-life). Tui-agent rows pull it from the
 * `TuiAgentProjection` that already carries it; chat / artifact rows
 * inherit it from the host hosting the open-epic projection.
 */
export interface EpicTreeRecord {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly type: EpicTreeNodeType;
  readonly status: number | null;
  readonly hostId: string;
}

const EMPTY_RECORDS: ReadonlyArray<EpicTreeRecord> = Object.freeze([]);
const EMPTY_NODES: ReadonlyArray<TreeNode> = Object.freeze([]);
const EMPTY_CHAT_PROJECTIONS: ReadonlyArray<ChatProjection> = Object.freeze([]);
const EMPTY_TERMINAL_AGENT_PROJECTIONS: ReadonlyArray<TuiAgentProjection> =
  Object.freeze([]);
const EMPTY_NODES_AS_ARTIFACTS: ReadonlyArray<ArtifactProjection> =
  Object.freeze([]);
const EMPTY_TREE_ID_ARRAY: readonly string[] = EMPTY_ARRAY;
const EMPTY_TREE_ID_SET: ReadonlySet<string> = new Set<string>();
const EMPTY_ROLE_CLAIMS: readonly RoleClaim[] = Object.freeze([]);
const EMPTY_ROLE_CLAIMS_BY_AGENT_ID: Readonly<
  Record<string, readonly RoleClaim[]>
> = Object.freeze({});

export { EMPTY_TREE_ID_ARRAY, EMPTY_TREE_ID_SET };

// ─── Snapshot meta + connection state ─────────────────────────────────────

export function useEpicSnapshotMeta(): SnapshotMetaEpic | null {
  return useEpicStore((s) => s.snapshotMeta);
}

export function useEpicConnectionStatus(): StreamConnectionStatus {
  return useEpicStore((s) => s.connectionStatus);
}

// Maybe-scoped rather than throwing outside <EpicSessionProvider>: the
// comment sidebar renders outside the session tree in some mounts, and "no
// session" is honestly the same answer as "the host has not said" - null.
export function useEpicDurabilityStatus(): NonNullable<
  OpenEpicState["durabilityStatus"]
> | null {
  return useMaybeEpicStore((s) => s.durabilityStatus ?? null, null);
}

export function useEpicDurabilityPauseReason(): NonNullable<
  OpenEpicState["durabilityPauseReason"]
> | null {
  return useMaybeEpicStore((s) => s.durabilityPauseReason ?? null, null);
}

/**
 * Whether this epic has no cloud comment room, and therefore no comments.
 *
 * ## Why a shared predicate and not `status === "local"` at each gate
 *
 * Two gates - the sidebar and the collab tile - each compared to the literal
 * `"local"`, and both missed `promoting`. `promoting` is the reserved-but-
 * pre-cutover window: the promotion is recorded, the upload is in flight, and
 * the artifact room's collab provider is STILL null. So comments re-enabled
 * themselves partway through promotion, the core threw a typed
 * `no_active_session`, and the user was shown "Comments couldn't be loaded" /
 * "Couldn't post comment" - a generic failure standing in for a boundary the
 * host knows exactly.
 *
 * `unknown` is deliberately NOT here. It means the host could not answer, and
 * the honest response to that is the ordinary read path plus whatever it
 * reports - not a confident claim that comments do not exist. Guessing in
 * either direction on `unknown` is the class of defect `s5-status-truthfulness`
 * exists to correct.
 */
export function commentsHaveNoCloudRoom(
  status: NonNullable<OpenEpicState["durabilityStatus"]> | null,
  pauseReason: string | null,
): boolean {
  if (status === "local" || status === "promoting") return true;
  // A preserved orphan: the epic was paused because its CLOUD copy was
  // deleted while never-uploaded local edits survived. The cloud comment room
  // went with the cloud copy, so enabling comments here offers actions that
  // can only fail against an absent room. The other pause reasons make no
  // such claim - an entitlement lapse or revoked access leaves the room in
  // place, merely unreachable, which is not this predicate's question.
  return (
    status === "paused" &&
    pauseReason === "orphaned-local-edits-after-cloud-delete"
  );
}

/**
 * {@link commentsHaveNoCloudRoom}, held across a subscription cycle's reset.
 *
 * ## Why the raw predicate is not enough AT A GATE
 *
 * The open-epic store clears `durabilityStatus` and `durabilityPauseReason`
 * whenever a subscription cycle starts, deliberately: last cycle's answer is
 * not evidence about this cycle's peer. So between a reconnect and the
 * replacement `cloudSyncStatus` frame the predicate sees `null` and answers
 * `false`.
 *
 * For the sync pill an unknown collapses toward silence, which is the safe
 * direction. Here it collapses the other way: `false` re-enables the comment
 * shortcut, toolbar, popovers and thread query against an epic that still has
 * no cloud room. A draft begun in that window is wiped by the very frame that
 * restores the gate, and a request sent from it could only fail.
 *
 * The latch is sound because a cloud comment room is a property of the EPIC,
 * not of the subscription cycle - a local-homed epic does not acquire one by
 * reconnecting. Only a POSITIVE statement writes it, `null` leaves the
 * previous answer standing, and it is keyed by epic so a different one never
 * inherits it.
 *
 * ## Why the absent statement still splits two ways
 *
 * Treating every `null` as "gate it" would disable comments FOREVER on any
 * peer below `@1.4`, which cannot emit the key at all - the population that
 * has always had working comments. `durabilityLegsNegotiated` separates a peer
 * that has not answered YET from one that CANNOT, exactly as it does in the
 * sync pill: the first waits behind the conservative gate, the second keeps
 * its released behaviour.
 */
export function useEpicCommentsHaveNoCloudRoom(): boolean {
  const status = useEpicDurabilityStatus();
  const pauseReason = useEpicDurabilityPauseReason();
  // `useMaybeEpicStore`, matching every sibling above: this gate renders in
  // the comments sidebar, which mounts outside an Epic session in its own
  // tests and in any host-scoped surface that has no open epic.
  const retainedStatus = useMaybeEpicStore(
    (s) => s.retainedDurabilityStatus ?? null,
    null,
  );
  const retainedPauseReason = useMaybeEpicStore(
    (s) => s.retainedDurabilityPauseReason ?? null,
    null,
  );
  const durabilityLegsNegotiated = useMaybeEpicStore(
    (s) => s.durabilityLegsNegotiated,
    false,
  );
  // This cycle's own answer wins whenever it has one.
  if (status !== null) return commentsHaveNoCloudRoom(status, pauseReason);
  // No statement yet. A peer that never negotiated the legs cannot produce
  // one at all, so gating on its silence would disable comments forever on
  // every pre-`@1.4` host - the population that has always had them.
  if (!durabilityLegsNegotiated) return false;
  if (retainedStatus !== null) {
    return commentsHaveNoCloudRoom(retainedStatus, retainedPauseReason);
  }
  // A negotiated peer that has not spoken yet, about an epic nothing has ever
  // said anything about. Withholding the affordance is the only direction
  // here that cannot offer an action the host will reject.
  return true;
}

/**
 * Whether this epic has no cloud task for its chats to back up into.
 *
 * The chat-backup twin of {@link commentsHaveNoCloudRoom}, and a separate
 * predicate rather than a reuse because the two gate DIFFERENT surfaces on the
 * same wire fact and may yet diverge: comments need the cloud comment room,
 * chat backup needs the cloud task row the publisher addresses. Today both
 * are absent through exactly the `local` and `promoting` window.
 *
 * The consumer is the sidebar's backup-status indicator: on a local-homed
 * epic every chat is honestly `behind` forever (there is nothing to publish
 * into), so rendering "N chats not backed up" there presents a by-design
 * state as an actionable failure. `unknown` is deliberately NOT gated, per
 * the `s5-status-truthfulness` rule {@link commentsHaveNoCloudRoom} states:
 * the host could not answer, so the ordinary surface renders what the backup
 * query reports.
 */
export function chatBackupHasNoCloudTask(
  status: NonNullable<OpenEpicState["durabilityStatus"]> | null,
  pauseReason: string | null,
): boolean {
  if (status === "local" || status === "promoting") return true;
  // Same fact as the comments predicate: the orphan pause means the cloud
  // TASK ROW is deleted, so there is nothing for the publisher to back a
  // chat up into and "N chats not backed up" would present a by-design
  // preservation state as an actionable failure.
  return (
    status === "paused" &&
    pauseReason === "orphaned-local-edits-after-cloud-delete"
  );
}

/**
 * Tolerant of a missing session on purpose: the only caller is the Epic
 * sidebar's backup indicator, which is a sibling of the canvas and mounts on
 * split surfaces that have no `<EpicSessionProvider>` above them. The strict
 * read threw straight through the surface's error boundary and blanked it.
 *
 * With no open epic the answer is `false` - "nothing here says there is no
 * cloud task" - which is the same fail-open direction the host-side gate uses:
 * a wrong `true` silently hides a real backup failure, a wrong `false` only
 * shows an indicator that the query then finds nothing to report.
 */
export function useEpicChatBackupHasNoCloudTask(): boolean {
  const status = useMaybeEpicStore((s) => s.durabilityStatus ?? null, null);
  const pauseReason = useMaybeEpicStore(
    (s) => s.durabilityPauseReason ?? null,
    null,
  );
  return chatBackupHasNoCloudTask(status, pauseReason);
}

export function useEpicDurabilityPromotionState(): NonNullable<
  OpenEpicState["durabilityPromotionState"]
> | null {
  return useEpicStore((s) => s.durabilityPromotionState ?? null);
}

/**
 * Host dirtiness is known only after this subscription cycle's atomic @1.1
 * snapshot. A clean-looking map before then (or under a negotiated @1.0 host)
 * is unknown rather than evidence that the cloud has acknowledged everything.
 */
const selectHostDirtyState = createSelector(
  (s: OpenEpicState) => s.hasDirtySnapshotForOpenCycle,
  (s: OpenEpicState) => s.rootDirty,
  (s: OpenEpicState) => s.artifactRoomDirtyByArtifactRoomId,
  (
    hasDirtySnapshotForOpenCycle,
    rootDirty,
    dirtyByArtifactRoomId,
  ): EpicHostDirtyState => {
    if (!hasDirtySnapshotForOpenCycle || rootDirty === null) return "unknown";
    if (rootDirty) return "dirty";
    return Object.values(dirtyByArtifactRoomId).some((dirty) => dirty)
      ? "dirty"
      : "clean";
  },
);

/**
 * The sync pill's single source of truth. Weighs all four legs of the
 * durability chain rather than the lossy blended `connectionStatus` the pill
 * used to read on its own - see `@/lib/epic-sync-pill-state` for the ordering
 * contract and why each leg has to be visible separately.
 *
 * Returns a plain string union, so an unchanged verdict is `Object.is`-equal
 * and never re-renders the pill.
 */
export function useEpicSyncPillState(): EpicSyncPillState {
  return useEpicStore((s) =>
    deriveEpicSyncPillState({
      hostTransportStatus: s.hostTransportStatus,
      cloudSyncStatus: s.cloudSyncStatus,
      hasFreshCloudSyncStatus: s.hasFreshCloudSyncStatus,
      hostDirtyState: selectHostDirtyState(s),
      hasUnsyncedLocalChanges: s.isDirty,
      hasConnectedOnce: s.hasConnectedOnce,
      // The two legs the pill used to ignore entirely. Without them the pill
      // could derive `synced` from a `LocalRoomConnection` and render "All
      // changes synced" beside the badge's "Stored locally" -
      // `s5-status-truthfulness` instance 1.
      durability: s.durabilityStatus ?? undefined,
      localProtection: s.localProtection ?? undefined,
      durabilityLegsNegotiated: s.durabilityLegsNegotiated,
      // The ninth leg, and the one that is about the DOCUMENT rather than
      // about where the work is going - `s5-mirror-first-serving`.
      cloudFreshness: s.cloudFreshness ?? undefined,
    }),
  );
}

/**
 * The ONE reading of the `@1.4` durability pair, for every surface that
 * renders it - `s5-status-truthfulness`.
 *
 * The class this closes is that the host derives honest state, the protocol
 * used to drop it, and each renderer null-rendered into the calm value
 * independently. Five instances of that were found; fixing them one at a time
 * leaves the sixth for a user to find, so the reading lives here and the
 * components render what it says.
 *
 * The `indeterminate` arm is the whole point: `unknown`, and an absence from a
 * peer that CAN speak `@1.4`, both land there, and no surface may resolve
 * either one as protected or synced.
 */
export type EpicDurabilityView =
  /** A pre-`@1.4` peer. Renders exactly as it did before this minor. */
  | { readonly kind: "legacy"; readonly status: EpicDurabilityStatusV15 | null }
  /** The host stated where the epic is durable. */
  | {
      readonly kind: "stated";
      readonly status: Exclude<EpicDurabilityStatusV15, "unknown" | "cloud">;
      readonly protection: EpicLocalProtection;
    }
  /**
   * Durable in the cloud. The calm arm - but calm about DURABILITY only:
   * protection is the independent axis, and `unavailable` beside `cloud`
   * still means offline edits die with the process, so the leg rides along
   * for the risk copy instead of being swallowed by the calm verdict.
   */
  | { readonly kind: "cloudDurable"; readonly protection: EpicLocalProtection }
  /** The host cannot say, or said it has no local protection. */
  | {
      readonly kind: "indeterminate";
      readonly protection: EpicLocalProtection;
    };

export function deriveEpicDurabilityView(
  status: EpicDurabilityStatusV15 | null,
  protection: EpicLocalProtection | null,
  peerSpeaksDurabilityLegs: boolean,
): EpicDurabilityView {
  // Which SILENCE this is, decided by the handshake rather than by the shape
  // of the frame.
  //
  // The shipping host emits `localProtection` on every `@1.4` frame, so a
  // presence probe agrees with the negotiated minor against it - but the
  // schema marks every `@1.4` leg optional and states that an absent one means
  // UNKNOWN, so a peer omitting one is speaking the contract, not failing it.
  // Reading that omission as "old peer" resolves a stated unknown into the
  // pre-`@1.4` silent rendering, which is the silence-as-reassurance inference
  // this minor exists to break. `peerSpeaksDurabilityLegs` is `false` until the
  // session's handshake settles, so an unheard peer still keeps its prior
  // rendering and the additive minor stays additive.
  //
  // Presence is still honoured as the other direction: a peer that SENT the
  // key demonstrably speaks it, whatever the negotiated version reader says.
  if (protection === null && !peerSpeaksDurabilityLegs) {
    return { kind: "legacy", status };
  }
  // Absence from a peer that speaks the legs is the wire contract's UNKNOWN.
  const stated: EpicLocalProtection = protection ?? "unknown";
  if (status === "cloud") {
    // The POSITIVE cloud-durable statement the `@1.4` enum carries. Calm
    // rests on this member alone - never on an absence. The protection leg is
    // KEPT, not resolved by the calm: the axes are independent, and a stated
    // `unavailable` beside `cloud` is exactly the "No local backup" risk the
    // badge exists to surface.
    return { kind: "cloudDurable", protection: stated };
  }
  if (status === null || status === "unknown") {
    // The frame's absence rule, stated as code: an absent `durability` key
    // from a `@1.4` peer means UNKNOWN, never synced. Review found the
    // earlier arm here resolving absence-beside-`armed` into the calm
    // rendering, which let a schema-permitted omission claim "All changes
    // synced" - the silence-as-reassurance inference this minor exists to
    // break. The shipping host now emits `"cloud"` explicitly, so the calm
    // case lost nothing.
    return { kind: "indeterminate", protection: stated };
  }
  // `stated` KEEPS its protection leg rather than collapsing to
  // `indeterminate` when that leg is `unavailable`: the two are separate axes,
  // and the concrete status is what gates the badge's paused-only remedies
  // (Upgrade, Export). Rendering both is `epicDurabilityRiskCopy`'s job.
  return { kind: "stated", status, protection: stated };
}

/** The composed durability reading for the open epic. */
export function useEpicDurabilityView(): EpicDurabilityView {
  // `useShallow` per this file's own object-select rule: the derivation builds
  // a fresh literal on every call, so a bare select hands `useSyncExternalStore`
  // a new snapshot each read and the badge re-renders itself to the update-depth
  // ceiling.
  return useEpicStore(
    useShallow((s) =>
      deriveEpicDurabilityView(
        s.durabilityStatus ?? null,
        s.localProtection ?? null,
        s.durabilityLegsNegotiated,
      ),
    ),
  );
}

/** Raw `localProtection`, for surfaces that gate on protection alone. */
export function useEpicLocalProtection(): EpicLocalProtection | null {
  return useEpicStore((s) => s.localProtection ?? null);
}

/**
 * The ONE reading of `@1.4`'s `freshness` datum - `s5-mirror-first-serving`.
 *
 * Deliberately the same shape of answer as {@link EpicDurabilityView}, and for
 * the same reason: the host derives an honest state, every renderer used to
 * null-render it into the calm value independently, and the fix is one reading
 * that the components then render.
 *
 * `unknown` covers BOTH an absent key and a peer that cannot speak `@1.4`, and
 * it is deliberately calm - the host omits `freshness` for a local-homed epic
 * (there is no cloud copy for it to be behind) and for a cloud row it has no
 * record of. Absence here therefore means "no freshness question applies",
 * which is why it renders exactly as it did before this minor. The one
 * inference this type refuses to let a caller make is the opposite one: there
 * is no arm that turns silence into `current`.
 */
export type EpicCloudFreshnessView =
  | { readonly kind: "unknown" }
  | {
      readonly kind: "stated";
      readonly state: EpicCloudFreshnessState;
      /**
       * The last SUCCESSFUL full root reconciliation, or `null` when this host
       * has never recorded one. `null` beside `current` is structurally
       * impossible on the wire, which is why the union carries the two
       * together rather than as independent optionals.
       */
      readonly reconciledAtEpochMs: number | null;
    };

export function deriveEpicCloudFreshnessView(
  freshness: EpicCloudFreshness | null,
): EpicCloudFreshnessView {
  if (freshness === null) return { kind: "unknown" };
  return freshness.kind === "lastCloudSyncAt"
    ? {
        kind: "stated",
        state: freshness.state,
        reconciledAtEpochMs: freshness.reconciledAtEpochMs,
      }
    : { kind: "stated", state: freshness.state, reconciledAtEpochMs: null };
}

/** The composed freshness reading for the open epic. */
export function useEpicCloudFreshnessView(): EpicCloudFreshnessView {
  // Object-shaped select; see {@link useEpicDurabilityView}.
  return useEpicStore(
    useShallow((s) => deriveEpicCloudFreshnessView(s.cloudFreshness ?? null)),
  );
}

export function useEpicPermissionRole(): PermissionRole | null {
  return useEpicStore((s) => s.permissionRole);
}

export function useEpicSnapshotLoaded(): boolean {
  return useEpicStore((s) => s.snapshotLoaded);
}

export function useEpicChatRecordListAuthoritative(): boolean {
  return useEpicStore((s) => s.chatRecordListAuthoritative);
}

export function useEpicSnapshotFetchError(): SnapshotFetchError | null {
  return useEpicStore((s) => s.snapshotFetchError);
}

export function useEpicRequestFreshSnapshot(): () => void {
  return useEpicStore((s) => s.requestFreshSnapshot);
}

/**
 * Reactive view of the per-epic major-migration slice. The modal subscribes
 * here to decide between idle (don't render), running (show step list), and
 * error (show retry/close) states. Identity-stable across snapshots that
 * leave the slice unchanged.
 */
export function useEpicMigrationState(): EpicMigrationSlice {
  return useEpicStore((s) => s.migration);
}

/**
 * Action hook for the migration modal's Retry button. Sends a
 * `retryMigration` client frame and snaps the slice back to running.
 */
export function useEpicRetryMigration(): () => void {
  return useEpicStore((s) => s.retryMigration);
}

export function useEpicLastFocusedArtifactId(): string | null {
  return useEpicStore((s) => s.lastFocusedArtifactId);
}

/**
 * Stable epic id of the open-epic session (the value the surrounding
 * `<EpicSessionProvider>` was mounted with). Reads off the handle, not
 * the store state, so consumers do not subscribe to unrelated store
 * field changes.
 */
export function useOpenEpicId(): string {
  return useOpenEpicHandle().epicId;
}

// ─── Title ────────────────────────────────────────────────────────────────

export function useEpicTitle(): string {
  return useEpicStore((s) => {
    if (s.epic.title.length > 0) return s.epic.title;
    return s.snapshotMeta?.epicLight?.title ?? "";
  });
}

export function useRegisteredEpicTitle(epicId: string | null): string | null {
  const registry = getOpenEpicRegistry();
  const handle = useSyncExternalStore(
    (listener) => registry.subscribe(listener),
    () => (epicId === null ? null : registry.peek(epicId)),
    () => null,
  );
  return useSyncExternalStore(
    (listener) => handle?.store.subscribe(listener) ?? noopSubscribe,
    () => liveEpicTitleFromHandle(handle),
    () => null,
  );
}

export function useRegisteredEpicPermissionRole(
  epicId: string | null,
): PermissionRole | null {
  const registry = getOpenEpicRegistry();
  const handle = useSyncExternalStore(
    (listener) => registry.subscribe(listener),
    () => (epicId === null ? null : registry.peek(epicId)),
    () => null,
  );
  return useSyncExternalStore(
    (listener) => handle?.store.subscribe(listener) ?? noopSubscribe,
    () => liveEpicPermissionRoleFromHandle(handle),
    () => null,
  );
}

export function useRegisteredEpicTitleGenerating(
  epicId: string | null,
): boolean {
  const registry = getOpenEpicRegistry();
  const handle = useSyncExternalStore(
    (listener) => registry.subscribe(listener),
    () => (epicId === null ? null : registry.peek(epicId)),
    () => null,
  );
  const currentTitle = useSyncExternalStore(
    (listener) => handle?.store.subscribe(listener) ?? noopSubscribe,
    () => liveEpicTitleFromHandle(handle),
    () => null,
  );
  const currentUpdatedAt = useSyncExternalStore(
    (listener) => handle?.store.subscribe(listener) ?? noopSubscribe,
    () => liveEpicUpdatedAtFromHandle(handle),
    () => null,
  );
  return useEpicCanvasStore((s) => {
    if (epicId === null) return false;
    const entry = Object.hasOwn(s.pendingEpicTitles, epicId)
      ? s.pendingEpicTitles[epicId]
      : undefined;
    return pendingTitleVisibleAutoPurge(
      entry,
      currentTitle,
      currentUpdatedAt,
      () => s.clearEpicTitlePending(epicId),
    );
  });
}

function noopSubscribe(): () => void {
  return noopUnsubscribe;
}

function noopUnsubscribe(): void {}

/**
 * Best-available live title for an open-epic handle: the projected Y.Doc
 * title, falling back to the snapshot-meta epicLight title, else `null`. The
 * single source of this precedence - reused by the header strip and the
 * access coordinator so a title-source change can't drift between them.
 */
export function liveEpicTitleFromHandle(
  handle: OpenEpicStoreHandle | null,
): string | null {
  if (handle === null) return null;
  const state = handle.store.getState();
  const title =
    state.epic.title.length > 0
      ? state.epic.title
      : (state.snapshotMeta?.epicLight?.title ?? "");
  return title.length > 0 ? title : null;
}

function liveEpicPermissionRoleFromHandle(
  handle: OpenEpicStoreHandle | null,
): PermissionRole | null {
  return handle?.store.getState().permissionRole ?? null;
}

function liveEpicUpdatedAtFromHandle(
  handle: OpenEpicStoreHandle | null,
): number | null {
  return handle?.store.getState().epic.updatedAt ?? null;
}

// ─── Artifact tree ────────────────────────────────────────────────────────

const artifactRecordCache = new WeakMap<ArtifactProjection, EpicTreeRecord>();
const artifactRecordByIdCache = new Map<string, EpicTreeRecord>();
const chatRecordCache = new WeakMap<ChatProjection, EpicTreeRecord>();
const terminalAgentRecordCache = new WeakMap<
  TuiAgentProjection,
  EpicTreeRecord
>();

function recordForArtifact(
  a: ArtifactProjection,
  hostId: string,
): EpicTreeRecord {
  const cached = artifactRecordCache.get(a);
  if (cached !== undefined && cached.hostId === hostId) return cached;
  const name = displayTitle(a.title, a.kind);
  const cachedById = artifactRecordByIdCache.get(a.id);
  if (
    cachedById !== undefined &&
    cachedById.parentId === a.parentId &&
    cachedById.name === name &&
    cachedById.type === a.kind &&
    cachedById.status === a.status &&
    cachedById.hostId === hostId
  ) {
    artifactRecordCache.set(a, cachedById);
    return cachedById;
  }
  const record: EpicTreeRecord = {
    id: a.id,
    parentId: a.parentId,
    name,
    type: a.kind,
    status: a.status,
    hostId,
  };
  artifactRecordCache.set(a, record);
  artifactRecordByIdCache.set(a.id, record);
  return record;
}

function recordForChat(c: ChatProjection, hostId: string): EpicTreeRecord {
  const cached = chatRecordCache.get(c);
  if (cached !== undefined && cached.hostId === hostId) return cached;
  const record: EpicTreeRecord = {
    id: c.id,
    parentId: c.parentId,
    // Durable Agent tree row: an untitled Chat-interface Agent falls back to
    // "Untitled agent"; `type` stays the interface discriminator.
    name: displayTitle(c.title, "agent"),
    type: "chat",
    status: null,
    hostId,
  };
  chatRecordCache.set(c, record);
  return record;
}

function recordForTerminalAgent(a: TuiAgentProjection): EpicTreeRecord {
  const cached = terminalAgentRecordCache.get(a);
  if (cached !== undefined) return cached;
  const record: EpicTreeRecord = {
    id: a.id,
    parentId: a.parentId,
    // Durable Agent tree row: an untitled Terminal-interface Agent falls back
    // to "Untitled agent" too (harness identity is separate interface metadata,
    // not the title fallback); `type` stays the interface discriminator.
    name: displayTitle(a.title, "agent"),
    type: "terminal-agent",
    status: null,
    hostId: a.hostId,
  };
  terminalAgentRecordCache.set(a, record);
  return record;
}

export function epicTreeRecordForNodeId(
  state: OpenEpicState,
  nodeId: string,
  fallbackHostId: string,
): EpicTreeRecord | null {
  if (Object.hasOwn(state.chats.byId, nodeId)) {
    return recordForChat(state.chats.byId[nodeId], fallbackHostId);
  }
  if (Object.hasOwn(state.tuiAgents.byId, nodeId)) {
    return recordForTerminalAgent(state.tuiAgents.byId[nodeId]);
  }
  if (Object.hasOwn(state.artifacts.byId, nodeId)) {
    return recordForArtifact(state.artifacts.byId[nodeId], fallbackHostId);
  }
  return null;
}

export function epicNodeRefForNodeId(
  state: OpenEpicState,
  nodeId: string,
  fallbackHostId: string,
): EpicNodeRef | null {
  const record = epicTreeRecordForNodeId(state, nodeId, fallbackHostId);
  if (record === null || !isOpenableEpicNodeKind(record.type)) return null;
  return {
    id: record.id,
    instanceId: uuidv4(),
    type: record.type,
    name: record.name,
    hostId: record.hostId,
  };
}

export function useEpicArtifactRecords(): ReadonlyArray<EpicTreeRecord> {
  const handle = useOpenEpicHandle();
  // Chat / artifact projections do not yet carry a hostId (only tui-agents
  // do). The host that SERVES this projection is the Epic session's host - the
  // one `handle` was acquired against - not the app-wide addressable host:
  // during an A→B re-point the A-backed Epic stays rendered while the
  // addressable host already answers B, and every record stamped here is
  // copied by its consumers (`AgentReferenceChip`, the route-focus opener) into
  // a tile ref that is bound for life. Tui-agent rows override with their
  // projected hostId.
  const fallbackHostId =
    getEpicSessionHandleHostId(handle) ?? UNKNOWN_HOST_PLACEHOLDER;
  return useStore(
    handle.store,
    useShallow((s): ReadonlyArray<EpicTreeRecord> => {
      if (
        s.chats.allIds.length === 0 &&
        s.artifacts.allIds.length === 0 &&
        s.tuiAgents.allIds.length === 0
      ) {
        return EMPTY_RECORDS;
      }
      const records: EpicTreeRecord[] = [];
      for (const id of s.chats.allIds) {
        records.push(recordForChat(s.chats.byId[id], fallbackHostId));
      }
      for (const id of s.tuiAgents.allIds) {
        records.push(recordForTerminalAgent(s.tuiAgents.byId[id]));
      }
      for (const id of s.artifacts.allIds) {
        records.push(recordForArtifact(s.artifacts.byId[id], fallbackHostId));
      }
      return records;
    }),
  );
}

export function useEpicHasArtifactRecords(): boolean {
  return useEpicStore(
    (s) =>
      s.chats.allIds.length > 0 ||
      s.artifacts.allIds.length > 0 ||
      s.tuiAgents.allIds.length > 0,
  );
}

export function useEpicTerminalAgent(
  tuiAgentId: string | null,
): TuiAgentProjection | null {
  return useEpicStore((s) => {
    if (tuiAgentId === null) return null;
    if (Object.hasOwn(s.tuiAgents.byId, tuiAgentId)) {
      return s.tuiAgents.byId[tuiAgentId];
    }
    return null;
  });
}

/**
 * Projected chat records for the sidebar / tabs and the initial-chat-handoff
 * adoption check. Single source of truth: the epic Y.Doc projection.
 */
export function useEpicChatRecords(): ReadonlyArray<ChatProjection> {
  const handle = useOpenEpicHandle();
  return useStore(
    handle.store,
    useShallow((s): ReadonlyArray<ChatProjection> => {
      if (s.chats.allIds.length === 0) return EMPTY_CHAT_PROJECTIONS;
      return s.chats.allIds.map((id) => s.chats.byId[id]);
    }),
  );
}

/**
 * Ids of the chats + terminal-agents whose record carries `archivedAt !== null`
 * - the archive roots the sidebar hides subtrees from. Chats and TUI agents are
 * merged into one list because a single `epic.setChatArchived` RPC keyed by id
 * covers both record kinds, so the tree treats them identically.
 *
 * Returned as a SORTED array rather than a `Set` so `useShallow` can bail the
 * subscriber's re-render: archiving is rare while chat projections churn
 * constantly (titles, `updatedAt`, streaming settings), and an unsorted or
 * freshly-allocated `Set` would re-render the whole tree on every one of those.
 */
export function useEpicArchivedNodeIds(): ReadonlyArray<string> {
  const handle = useOpenEpicHandle();
  return useStore(
    handle.store,
    useShallow((s): ReadonlyArray<string> => {
      const archived = [
        ...s.chats.allIds.filter((id) => s.chats.byId[id].archivedAt !== null),
        ...s.tuiAgents.allIds.filter(
          (id) => s.tuiAgents.byId[id].archivedAt !== null,
        ),
      ];
      if (archived.length === 0) return EMPTY_TREE_ID_ARRAY;
      return archived.sort();
    }),
  );
}

/**
 * Every chat id this epic's projection holds, nested ones included.
 *
 * The dedup set for the cloud-chat section: a chat the LOCAL tree already
 * renders must not also appear under "on your other devices", or one chat reads
 * as two. Deliberately the projection rather than the host's chat registry -
 * the question is "what does this sidebar already show", and a chat the
 * registry knows but the projection has not materialized would be hidden from
 * both surfaces if the registry were the authority.
 *
 * Returned SORTED rather than as a `Set`, for the reason
 * {@link useEpicArchivedNodeIds} gives: chat projections churn constantly
 * (titles, `updatedAt`, streaming settings) while the id SET moves only on
 * create/delete, and a freshly-allocated `Set` would defeat `useShallow` and
 * re-render on every one of those.
 */
export function useEpicChatIds(): ReadonlyArray<string> {
  const handle = useOpenEpicHandle();
  return useStore(
    handle.store,
    useShallow((s): ReadonlyArray<string> => {
      if (s.chats.allIds.length === 0) return EMPTY_TREE_ID_ARRAY;
      return [...s.chats.allIds].sort();
    }),
  );
}

/**
 * Ids of every chat + terminal agent this epic's projection currently holds.
 *
 * PRESENCE, not liveness or visibility: an archived or idle node is still here;
 * only a DELETED one is absent. Callers use it to drop references to nodes that
 * no longer exist - host-side records that outlive their node (a PR's owner set
 * is one: worktree bindings cascade on epic delete but not on chat delete) name
 * ids this epic can no longer resolve to a title or a tile.
 *
 * Two plain reads plus a memo, NOT one `useShallow` selector that rebuilds the
 * combined array. `useShallow` bails the subscriber's re-render but not the
 * selector RUN: zustand executes it once per subscriber on every notification,
 * and the PR panel mounts one subscriber per row, so combining in there costs
 * O(rows x agents) on every projection tick - including the title/`updatedAt`
 * churn this membership list does not care about.
 *
 * Memoising on array IDENTITY is safe because the projector guarantees it:
 * `pickStableIds` hands back the PREVIOUS array whenever the ids are
 * shallow-equal, so these references change only when a node is really added or
 * removed. Unordered, because every caller asks it membership questions.
 */
export function useEpicAgentNodeIds(): ReadonlyArray<string> {
  const handle = useOpenEpicHandle();
  const chatIds = useStore(handle.store, (s) => s.chats.allIds);
  const terminalAgentIds = useStore(handle.store, (s) => s.tuiAgents.allIds);
  return useMemo(() => {
    if (chatIds.length === 0 && terminalAgentIds.length === 0) {
      return EMPTY_TREE_ID_ARRAY;
    }
    return [...chatIds, ...terminalAgentIds];
  }, [chatIds, terminalAgentIds]);
}

export function useEpicTerminalAgentRecords(): ReadonlyArray<TuiAgentProjection> {
  const handle = useOpenEpicHandle();
  return useStore(
    handle.store,
    useShallow((s): ReadonlyArray<TuiAgentProjection> => {
      if (s.tuiAgents.allIds.length === 0) {
        return EMPTY_TERMINAL_AGENT_PROJECTIONS;
      }
      return s.tuiAgents.allIds.map((id: string) => s.tuiAgents.byId[id]);
    }),
  );
}

export function useEpicArtifact(
  artifactId: string | null,
): ArtifactProjection | ChatProjection | TuiAgentProjection | null {
  return useEpicStore((s) => {
    if (artifactId === null) return null;
    if (Object.hasOwn(s.artifacts.byId, artifactId)) {
      return s.artifacts.byId[artifactId];
    }
    if (Object.hasOwn(s.chats.byId, artifactId)) {
      return s.chats.byId[artifactId];
    }
    if (Object.hasOwn(s.tuiAgents.byId, artifactId)) {
      return s.tuiAgents.byId[artifactId];
    }
    return null;
  });
}

type EpicAgentProjection = ChatProjection | TuiAgentProjection;

const MIN_AGENT_REFERENCE_PREFIX_LENGTH = 4;

function exactEpicAgent(
  state: Pick<OpenEpicState, "chats" | "tuiAgents">,
  agentId: string,
): EpicAgentProjection | null {
  if (Object.hasOwn(state.chats.byId, agentId)) {
    return state.chats.byId[agentId];
  }
  if (Object.hasOwn(state.tuiAgents.byId, agentId)) {
    return state.tuiAgents.byId[agentId];
  }
  return null;
}

/**
 * Resolves the agent-id syntax accepted by the host: exact id first, then a
 * unique case-sensitive prefix of at least four characters. Role-claim ids and
 * artifact ids are deliberately outside this candidate set.
 */
function resolveEpicAgentReference(
  state: Pick<OpenEpicState, "chats" | "tuiAgents">,
  referenceId: string,
): EpicAgentProjection | null {
  const exact = exactEpicAgent(state, referenceId);
  if (exact !== null) return exact;
  if (referenceId.length < MIN_AGENT_REFERENCE_PREFIX_LENGTH) return null;

  let matchedId: string | null = null;
  for (const candidateId of [
    ...state.chats.allIds,
    ...state.tuiAgents.allIds,
  ]) {
    if (!candidateId.startsWith(referenceId)) continue;
    if (matchedId !== null && matchedId !== candidateId) return null;
    matchedId = candidateId;
  }
  return matchedId === null ? null : exactEpicAgent(state, matchedId);
}

export function useEpicAgentReference(
  referenceId: string,
): EpicAgentProjection | null {
  return useEpicStore((state) => resolveEpicAgentReference(state, referenceId));
}

export function useEpicLiveArtifactTitle(
  artifactId: string | null,
): string | null {
  return useEpicStore((s) => {
    if (artifactId === null) return null;
    if (Object.hasOwn(s.artifacts.byId, artifactId)) {
      const title = s.artifacts.byId[artifactId].title;
      return title.length > 0 ? title : null;
    }
    if (Object.hasOwn(s.chats.byId, artifactId)) {
      const title = s.chats.byId[artifactId].title;
      return title.length > 0 ? title : null;
    }
    if (Object.hasOwn(s.tuiAgents.byId, artifactId)) {
      const title = s.tuiAgents.byId[artifactId].title;
      return title.length > 0 ? title : null;
    }
    return null;
  });
}

/**
 * Live artifact title for an epic session that may be mounted elsewhere in
 * the app. Global surfaces (for example, the resource monitor) live outside
 * an `EpicSessionProvider`, but must use the same Y.Doc-backed title that a
 * canvas tab uses instead of its persisted opening-name snapshot.
 */
export function useRegisteredEpicLiveArtifactTitle(
  epicId: string,
  artifactId: string | null,
): string | null {
  const registry = getOpenEpicRegistry();
  const handle = useSyncExternalStore(
    (listener) => registry.subscribe(listener),
    () => registry.peek(epicId),
    () => null,
  );
  return useSyncExternalStore(
    (listener) => handle?.store.subscribe(listener) ?? noopSubscribe,
    () => liveArtifactTitleFromHandle(handle, artifactId),
    () => null,
  );
}

export interface RegisteredEpicArtifactTitleRef {
  readonly epicId: string;
  readonly artifactId: string | null;
}

/**
 * Reactive live titles for a dynamic collection of artifacts. Global list
 * surfaces cannot call the single-artifact hook in a data-dependent loop, so
 * this subscribes once to the registry and every currently referenced epic.
 */
export function useRegisteredEpicLiveArtifactTitles(
  refs: readonly RegisteredEpicArtifactTitleRef[],
): readonly (string | null)[] {
  const registry = getOpenEpicRegistry();
  const encodedTitles = useSyncExternalStore(
    (listener) => {
      const unsubscribeByHandle = new Map<object, () => void>();
      const reconcileHandleSubscriptions = () => {
        const currentHandles = new Set<object>();
        for (const ref of refs) {
          const handle = registry.peek(ref.epicId);
          if (handle === null || currentHandles.has(handle)) continue;
          currentHandles.add(handle);
          if (!unsubscribeByHandle.has(handle)) {
            unsubscribeByHandle.set(handle, handle.store.subscribe(listener));
          }
        }
        for (const [handle, unsubscribe] of unsubscribeByHandle) {
          if (currentHandles.has(handle)) continue;
          unsubscribe();
          unsubscribeByHandle.delete(handle);
        }
      };
      reconcileHandleSubscriptions();
      const unsubscribeRegistry = registry.subscribe(() => {
        reconcileHandleSubscriptions();
        listener();
      });
      return () => {
        unsubscribeRegistry();
        for (const unsubscribe of unsubscribeByHandle.values()) unsubscribe();
      };
    },
    () => registeredArtifactTitlesSnapshot(registry, refs),
    () => JSON.stringify(refs.map(() => [0, null])),
  );
  return useMemo(
    () => decodeRegisteredArtifactTitles(encodedTitles),
    [encodedTitles],
  );
}

function registeredArtifactTitlesSnapshot(
  registry: OpenEpicSessionRegistry,
  refs: readonly RegisteredEpicArtifactTitleRef[],
): string {
  return JSON.stringify(
    refs.map((ref) => {
      const handle = registry.peek(ref.epicId);
      return [
        handle === null ? 0 : 1,
        liveArtifactTitleFromHandle(handle, ref.artifactId),
      ];
    }),
  );
}

function decodeRegisteredArtifactTitles(
  encodedTitles: string,
): readonly (string | null)[] {
  const decoded: unknown = JSON.parse(encodedTitles);
  if (!Array.isArray(decoded)) return [];
  return decoded.map((entry) => {
    if (!Array.isArray(entry)) return null;
    const title: unknown = entry[1];
    return typeof title === "string" ? title : null;
  });
}

function liveArtifactTitleFromHandle(
  handle: OpenEpicStoreHandle | null,
  artifactId: string | null,
): string | null {
  if (handle === null || artifactId === null) return null;
  const state = handle.store.getState();
  if (Object.hasOwn(state.artifacts.byId, artifactId)) {
    const title = state.artifacts.byId[artifactId].title;
    return title.length > 0 ? title : null;
  }
  if (Object.hasOwn(state.chats.byId, artifactId)) {
    const title = state.chats.byId[artifactId].title;
    return title.length > 0 ? title : null;
  }
  if (Object.hasOwn(state.tuiAgents.byId, artifactId)) {
    const title = state.tuiAgents.byId[artifactId].title;
    return title.length > 0 ? title : null;
  }
  return null;
}

/**
 * Canonical display title for a canvas tile / node. Live state is the single
 * source of truth - the Y.Doc title for record-backed nodes, the HOST's
 * `terminal.list` rows for terminal tabs (via `useTerminalDisplayTitle`,
 * keyed by the tab's bound host + session id). The tile's persisted `name`
 * snapshot is only a fallback for tiles that have no live title (workspace
 * files, git diff, pre-hydration, a terminal session the host no longer
 * knows). Every render site (visible tab strip, drag overlay, ...) MUST read
 * through this hook - never the raw `node.name` - so the resolve cannot be
 * forgotten in one place.
 *
 * `terminalHostClient` is the tab's bound-host client for terminal nodes
 * (`null` for every other node kind). The caller resolves it so one
 * `useHostClientForHostId` per tab serves both title resolution and the
 * rename mutation.
 */
type EpicTabDisplayTitleNode = {
  readonly id: string;
  readonly name: string;
  readonly type: string | undefined;
  /** The tab's bound host, for the node kinds that have one. */
  readonly hostId: string | null;
};

export function useEpicTabDisplayTitle(
  node: EpicTabDisplayTitleNode,
  epicId: string,
  terminalHostClient: HostClient<HostRpcRegistry> | null,
): string {
  const liveArtifactTitle = useEpicLiveArtifactTitle(node.id);
  const isTerminal = node.type === "terminal";
  const liveTerminalTitle = useTerminalDisplayTitle({
    client: isTerminal ? terminalHostClient : null,
    epicId: isTerminal ? epicId : null,
    sessionId: isTerminal ? node.id : null,
  });
  // An output window's tile carries no label at all (its persisted shape is
  // just the command pointer), so the kind-explicit title comes from the owning
  // chat's live set - and follows a rename the agent makes.
  const isManagedCommandOutput = node.type === "managed-command-output";
  const managedCommand = useManagedCommandOnHost({
    epicId,
    // The tab's own host, never the epic at large: a clone carries the source
    // transcript's command ids, and a title read across hosts would name a
    // shell this tab cannot open.
    hostId: isManagedCommandOutput ? (node.hostId ?? "") : "",
    commandId: isManagedCommandOutput ? node.id : "",
  });
  const liveManagedCommandTitle =
    managedCommand === null ? null : managedCommandTitle(managedCommand);
  return (
    liveArtifactTitle ??
    liveTerminalTitle ??
    liveManagedCommandTitle ??
    node.name
  );
}

export function useEpicLiveArtifactTitleGenerating(
  artifactId: string | null,
): boolean {
  const currentTitle = useEpicStore((s) => {
    if (artifactId === null) return null;
    if (Object.hasOwn(s.chats.byId, artifactId)) {
      const chat = s.chats.byId[artifactId];
      return chat.title.length > 0 ? chat.title : null;
    }
    return null;
  });
  const currentUpdatedAt = useEpicStore((s) => {
    if (artifactId === null) return null;
    if (Object.hasOwn(s.chats.byId, artifactId)) {
      return s.chats.byId[artifactId].updatedAt;
    }
    return null;
  });
  return useEpicCanvasStore((s) => {
    if (artifactId === null) return false;
    const entry = Object.hasOwn(s.pendingChatTitles, artifactId)
      ? s.pendingChatTitles[artifactId]
      : undefined;
    return pendingTitleVisibleAutoPurge(
      entry,
      currentTitle,
      currentUpdatedAt,
      () => s.clearChatTitlePending(artifactId),
    );
  });
}

/**
 * Returns the live `Y.XmlFragment` backing an artifact's body. The fragment
 * resolves through the artifact's assigned artifact-room doc (`artifact-body:{id}`),
 * not the root Epic doc - see B6 in the artifact-room approach spec.
 *
 * Selects the resolved fragment itself so any store write that makes the
 * artifact-room replica available wakes the editor, even when the room id and
 * binding counter are unchanged.
 */
export function useEpicArtifactFragment(
  artifactId: string | null,
): Y.XmlFragment | null {
  const handle = useOpenEpicHandle();
  // Takes the lease itself. The store's accessor is a pure read - it cannot
  // materialize a cold room, because it runs inside a selector - so a caller
  // that read without pinning would sit in a loading state forever. Bundling
  // the two makes the hook correct by construction; `getArtifactFragment` on
  // the store stays the escape hatch for non-React callers, which must lease
  // explicitly (see `useEpicExportArtifacts`).
  useEpicArtifactBodyLease(artifactId);
  return useStore(handle.store, (s) => {
    if (artifactId === null) return null;
    return s.getArtifactFragment(artifactId);
  });
}

/**
 * Returns the artifact-room-scoped `Awareness` instance hosting `artifactId`'s body
 * presence channel, or `null` until the artifactRoom transitions to `ready`. Used
 * by `CollabTileBody` to feed CollaborationCaret an Awareness instance
 * paired with the artifact-room doc the editor is bound to.
 *
 * Selects the resolved Awareness instance directly for the same reason as
 * {@link useEpicArtifactFragment}: callers should update when a store write
 * makes the artifact-room binding available, regardless of which public
 * invalidation field changed.
 */
export function useEpicArtifactBodyAwareness(
  artifactId: string | null,
): Awareness | null {
  const handle = useOpenEpicHandle();
  // Same reasoning as `useEpicArtifactFragment`; lease counts are refcounted,
  // so a component using both hooks simply holds two.
  useEpicArtifactBodyLease(artifactId);
  return useStore(handle.store, (s) => {
    if (artifactId === null) return null;
    return s.getArtifactBodyAwareness(artifactId);
  });
}

/**
 * Reports the availability of the artifact-room hosting `artifactId`'s body.
 * Drives the editor's loading/unavailable placeholder when the artifactRoom is
 * still opening or has failed. Selects through the store helper so artifact
 * metadata and artifact-room state are resolved together.
 */
export function useEpicArtifactBodyAvailability(
  artifactId: string | null,
): EpicArtifactRoomAvailability {
  const handle = useOpenEpicHandle();
  return useStore(handle.store, (s) => {
    if (artifactId === null) return "unavailable";
    return s.getArtifactBodyAvailability(artifactId);
  });
}

/**
 * Materializes `artifactId`'s artifact-room and holds it materialized for as
 * long as the calling component is mounted.
 *
 * Rooms the host opens are cached as encoded update bytes; taking a lease is
 * what builds the live `Y.Doc`, and holding it is what stops the room cooling
 * back down underneath a mounted editor. {@link useEpicArtifactFragment} and
 * {@link useEpicArtifactBodyAwareness} call this for you - use it directly
 * only to pin a room whose fragment this component does not itself read.
 *
 * The lease is re-taken when the resolved room id changes rather than only
 * when the artifact id does: an artifact reassigned between two rooms that are
 * both already `ready` produces no availability transition, so keying the
 * effect on availability alone would leave the lease on the stale room.
 */
export function useEpicArtifactBodyLease(artifactId: string | null): void {
  const handle = useOpenEpicHandle();
  const artifactRoomId = useStore(handle.store, (s) =>
    artifactId === null ? null : s.getArtifactRoomId(artifactId),
  );
  // Layout, not passive: this is what materializes the room, and a passive
  // effect runs after paint - the tile would show its skeleton for a frame
  // before the fragment resolved. A layout effect lands the lease, and the
  // resulting store update, before the browser paints.
  useLayoutEffect(() => {
    if (artifactId === null || artifactRoomId === null) return;
    return handle.store.getState().acquireArtifactBodyLease(artifactId);
  }, [handle, artifactId, artifactRoomId]);
}

// ─── Doc reference for editor binding ─────────────────────────────────────

/**
 * Returns the live Y.Doc + Y.Awareness owned by the current Epic session.
 * Tile editors bind these to `@tiptap/extension-collaboration` and
 * `@tiptap/extension-collaboration-caret` directly.
 */
export function useEpicDocBinding(): {
  readonly doc: Y.Doc;
  readonly awareness: OpenEpicStoreHandle["awareness"];
} {
  const handle = useOpenEpicHandle();
  useStore(handle.store, (s) => s.bindingVersion);
  return { doc: handle.doc, awareness: handle.awareness };
}

// ─── Agent activity (per-user notification-room presence) ─────────────────
//
// The source is the awareness replica on `notifications:<userId>` - the room
// every signed-in client subscribes to app-wide - NOT the per-epic
// collaboration room. That is what makes these hooks correct for an epic this
// window has never opened: the old per-epic reader could only see hosts whose
// epic room this client had joined, so the task list, epics panel and tab strip
// all read idle for a working agent in an epic that was never opened.
//
// Membership and tier semantics are unchanged from the retired per-epic fields
// - see `agent-activity-presence.ts` for the frozen-shape reader rules - so
// every consumer keeps reading exactly what it read before, from a source that
// now covers the whole user rather than this window's open sessions.

export type { AgentActivityTier };

const registeredLiveAgentIdsCache = new WeakMap<
  OpenEpicStoreHandle,
  { readonly ids: ReadonlySet<string>; readonly key: string }
>();

/**
 * The set of agents currently "working" (executing right now) anywhere in the
 * epic, unioned across every host publishing into the user's notification room
 * - so it is cross-host and reactive (re-renders when any host's working set
 * changes). Replaces the `agent.list` 2s poll for the Active Agents / stop
 * panels.
 */
export function useEpicActiveAgentIds(): ReadonlySet<string> {
  const epicId = useOpenEpicHandle().epicId;
  return useEpicAgentActivity(epicId).working;
}

/**
 * {@link useEpicActiveAgentIds} with each working agent resolved to its
 * {@link AgentActivityTier}. Prefer this when the caller distinguishes an
 * active turn from background-only work; the id set alone cannot.
 */
export function useEpicAgentActivityTiers(): ReadonlyMap<
  string,
  AgentActivityTier
> {
  const epicId = useOpenEpicHandle().epicId;
  return agentActivityTiers(useEpicAgentActivity(epicId));
}

/**
 * {@link useEpicActiveAgentIds} for surfaces that render outside the open-epic
 * provider (epic tabs, the epics panel, the task list). It no longer resolves a
 * registered session handle - presence for an epic no longer depends on this
 * window having a session for it - but the name is kept so these call sites
 * still read as a set with their `useRegisteredEpic*` neighbours.
 */
export function useRegisteredEpicActiveAgentIds(
  epicId: string | null,
): ReadonlySet<string> {
  return useEpicAgentActivity(epicId).working;
}

/**
 * {@link useRegisteredEpicActiveAgentIds} with each working agent resolved to
 * its {@link AgentActivityTier}.
 */
export function useRegisteredEpicAgentActivityTiers(
  epicId: string | null,
): ReadonlyMap<string, AgentActivityTier> {
  return agentActivityTiers(useEpicAgentActivity(epicId));
}

/**
 * The agent ids this epic's live projection currently holds, or `null` when
 * this window has no session for the epic at all.
 *
 * The `null` arm is load-bearing, and is why this does not simply return an
 * empty set: an epic with a session and no agents is authoritatively empty,
 * while an epic with no session is UNKNOWN. Callers use this as a liveness
 * filter over host-published presence, and filtering an unknown epic by an
 * empty set is exactly the bug the per-user activity room removes - an agent
 * working in an epic this window never opened would read idle again.
 */
export function useRegisteredEpicLiveAgentIds(
  epicId: string | null,
): ReadonlySet<string> | null {
  const registry = getOpenEpicRegistry();
  const handle = useSyncExternalStore(
    (listener) => registry.subscribe(listener),
    () => (epicId === null ? null : registry.peek(epicId)),
    () => null,
  );
  return useSyncExternalStore(
    (listener) => handle?.store.subscribe(listener) ?? noopSubscribe,
    () => liveAgentIdsSnapshot(handle),
    () => null,
  );
}

function liveAgentIdsSnapshot(
  handle: OpenEpicStoreHandle | null,
): ReadonlySet<string> | null {
  if (handle === null) return null;
  const state = handle.store.getState();
  const key = [...state.chats.allIds, ...state.tuiAgents.allIds]
    .sort()
    .join(" ");
  const cached = registeredLiveAgentIdsCache.get(handle);
  if (cached !== undefined && cached.key === key) return cached.ids;
  const ids = new Set<string>([
    ...state.chats.allIds,
    ...state.tuiAgents.allIds,
  ]);
  const entry = { ids, key };
  registeredLiveAgentIdsCache.set(handle, entry);
  return entry.ids;
}

// ─── Tree slice hooks ─────────────────────────────────────────────────────

export function useEpicTreeIndex(): TreeSlice {
  return useEpicStore((s) => s.tree);
}

export function useRootIds(): readonly string[] {
  return useEpicStore((s) => s.tree.rootIds);
}

export function useChildIds(parentId: string): readonly string[] {
  return useEpicStore((s) =>
    Object.hasOwn(s.tree.childrenByParent, parentId)
      ? s.tree.childrenByParent[parentId]
      : EMPTY_TREE_ID_ARRAY,
  );
}

export function useEpicTreeNode(id: string): TreeNode | null {
  return useEpicStore((s) => {
    if (Object.hasOwn(s.tree.nodeById, id)) return s.tree.nodeById[id];
    return null;
  });
}

export function useEpicAgentRoleClaims(agentId: string): readonly RoleClaim[] {
  const enabled = useAgentRolesEnabled();
  const claims = useEpicStore((s) =>
    Object.hasOwn(s.agentRoles.byAgentId, agentId)
      ? s.agentRoles.byAgentId[agentId]
      : EMPTY_ROLE_CLAIMS,
  );
  return enabled ? claims : EMPTY_ROLE_CLAIMS;
}

export function useEpicAgentRoleClaimsByAgentId(): Readonly<
  Record<string, readonly RoleClaim[]>
> {
  const enabled = useAgentRolesEnabled();
  const claims = useEpicStore((s) => s.agentRoles.byAgentId);
  return enabled ? claims : EMPTY_ROLE_CLAIMS_BY_AGENT_ID;
}

/**
 * Just this artifact's `status` scalar. Sidebar nodes need it for the status
 * dot on every render; selecting the scalar (instead of `find`-ing it out of
 * the full `useEpicArtifactRecords()` array) keeps the value reference-stable
 * while OTHER records churn - e.g. the active chat streaming - so the memoized
 * node bails. See RENDER_PERF_FINDINGS.md (T1 follow-up).
 */
export function useEpicArtifactStatus(id: string): number | null {
  return useEpicStore((s) =>
    Object.hasOwn(s.artifacts.byId, id) ? s.artifacts.byId[id].status : null,
  );
}

export function useAncestorIds(nodeId: string | null): ReadonlySet<string> {
  const index = useEpicTreeIndex();
  return useMemo(() => {
    if (nodeId === null) return EMPTY_TREE_ID_SET;
    if (!Object.hasOwn(index.nodeById, nodeId)) return EMPTY_TREE_ID_SET;
    const ancestors = new Set<string>();
    let current: string | null = index.nodeById[nodeId].parentId;
    while (current !== null && !ancestors.has(current)) {
      ancestors.add(current);
      if (!Object.hasOwn(index.nodeById, current)) break;
      current = index.nodeById[current].parentId;
    }
    return ancestors.size === 0 ? EMPTY_TREE_ID_SET : ancestors;
  }, [index, nodeId]);
}

export function useDescendantIds(nodeId: string): readonly string[] {
  const index = useEpicTreeIndex();
  return useMemo(() => {
    if (!Object.hasOwn(index.nodeById, nodeId)) return EMPTY_TREE_ID_ARRAY;
    const out: string[] = [];
    const visited = new Set<string>();
    const stack: string[] = [];
    if (Object.hasOwn(index.childrenByParent, nodeId)) {
      const seed = index.childrenByParent[nodeId];
      for (let i = seed.length - 1; i >= 0; i -= 1) {
        stack.push(seed[i]);
      }
    }
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      if (visited.has(current)) continue;
      visited.add(current);
      out.push(current);
      if (!Object.hasOwn(index.childrenByParent, current)) continue;
      const children = index.childrenByParent[current];
      for (let i = children.length - 1; i >= 0; i -= 1) {
        stack.push(children[i]);
      }
    }
    return out.length === 0 ? EMPTY_TREE_ID_ARRAY : out;
  }, [index, nodeId]);
}

/**
 * This artifact's own root-to-leaf on-disk folder-name chain (ending with
 * its own `folderName`), or `null` when it can't be reconstructed (unknown
 * id, a tree cycle, a non-artifact ancestor, or an empty folder name
 * somewhere in the chain). Feeds `resolveArtifactRelativeLinkPath` so a
 * relative markdown link authored inside this artifact can be rewritten into
 * the same artifact-shaped path the absolute-link flow already resolves.
 *
 * Selected via `useShallow` (a plain array of primitive strings) rather than
 * subscribing to the raw `tree`/`artifacts` slices directly: those slices get
 * a fresh top-level identity on ANY artifact edit anywhere in the epic, which
 * would otherwise re-render every link consumer even when THIS artifact's own
 * chain is unchanged.
 */
export function useArtifactFolderChain(
  artifactId: string,
): readonly string[] | null {
  return useEpicStore(
    useShallow((s) => artifactFolderChain(s.tree, s.artifacts, artifactId)),
  );
}

// ─── Reselect derived views (cross-slice / sorted / filtered) ─────────────

const selectArtifacts = (s: OpenEpicState): ArtifactsSlice => s.artifacts;
const selectChats = (s: OpenEpicState): ChatsSlice => s.chats;
const selectTree = (s: OpenEpicState): TreeSlice => s.tree;

/**
 * All artifacts of a given kind, sorted by `createdAt`. Memoized on
 * `(byId, allIds, kind)` so identity-stable sibling updates skip the
 * recomputation.
 */
export const makeSelectArtifactsByKind = (kind: ArtifactProjection["kind"]) =>
  createSelector(
    [selectArtifacts],
    (artifacts): ReadonlyArray<ArtifactProjection> => {
      const out: ArtifactProjection[] = [];
      for (const id of artifacts.allIds) {
        if (!Object.hasOwn(artifacts.byId, id)) continue;
        const a = artifacts.byId[id];
        if (a.kind === kind) out.push(a);
      }
      out.sort((a, b) => a.createdAt - b.createdAt);
      return out.length === 0 ? EMPTY_NODES_AS_ARTIFACTS : out;
    },
  );

/**
 * Top-level tree nodes. Identity stable while `tree.rootIds` and
 * `tree.nodeById` don't change reference.
 */
export const selectRootNodes = createSelector(
  [selectTree],
  (tree): ReadonlyArray<TreeNode> => {
    if (tree.rootIds.length === 0) return EMPTY_NODES;
    const out: TreeNode[] = [];
    for (const id of tree.rootIds) {
      if (Object.hasOwn(tree.nodeById, id)) out.push(tree.nodeById[id]);
    }
    return out;
  },
);

/**
 * Per-artifact composite view: artifact + tree node. Useful when a
 * component needs both shapes and otherwise would call two selectors.
 * Cached per id via `lruMemoize` so multiple components subscribing to
 * the same id share the result.
 */
export const makeSelectArtifactWithNode = (id: string) =>
  createSelector(
    [
      (s: OpenEpicState): ArtifactProjection | null =>
        Object.hasOwn(s.artifacts.byId, id) ? s.artifacts.byId[id] : null,
      (s: OpenEpicState): TreeNode | null =>
        Object.hasOwn(s.tree.nodeById, id) ? s.tree.nodeById[id] : null,
    ],
    (
      artifact,
      node,
    ): {
      readonly artifact: ArtifactProjection | null;
      readonly node: TreeNode | null;
    } => ({ artifact, node }),
    { memoize: lruMemoize },
  );

export function useArtifactWithNode(id: string): {
  readonly artifact: ArtifactProjection | null;
  readonly node: TreeNode | null;
} {
  const selector = useMemo(() => makeSelectArtifactWithNode(id), [id]);
  return useEpicStore(selector);
}

// ─── Convenience scalar reads (component-local one-liners) ────────────────

export function useArtifactById(id: string | null): ArtifactProjection | null {
  return useEpicStore((s) => {
    if (id === null) return null;
    if (Object.hasOwn(s.artifacts.byId, id)) return s.artifacts.byId[id];
    return null;
  });
}

/**
 * Reactive tombstone lookup for a deleted artifact. Returns the projected
 * `deletedArtifacts` entry, or null when the id is not (yet) a tombstone. The
 * chat's `artifact_operation` delete card subscribes here so it resolves the
 * strikethrough title + deletion info as soon as the tombstone syncs in, rather
 * than reading once.
 */
export function useEpicDeletedArtifact(
  id: string | null,
): DeletedArtifactProjection | null {
  return useEpicStore((s) => {
    if (id === null) return null;
    if (Object.hasOwn(s.deletedArtifacts.byId, id)) {
      return s.deletedArtifacts.byId[id];
    }
    return null;
  });
}

export function useChatById(id: string | null): ChatProjection | null {
  return useEpicStore((s) => {
    if (id === null) return null;
    if (Object.hasOwn(s.chats.byId, id)) return s.chats.byId[id];
    return null;
  });
}

/**
 * WHY a chat's record was retracted from this session, or `null` if it was not.
 *
 * The record table can only say a row is GONE. This says which of the two
 * honest things an open tab may claim about that: `deleted` (the chat is gone
 * for everyone) or `revoked` (it still exists; this viewer may no longer see
 * it). Only the push stream carries the distinction - a poll that stops
 * returning a row cannot - so this reads `null` on any host without
 * `host.chatRecords.subscribe`, and the tab keeps the pre-existing
 * reachability-derived end states.
 *
 * A single per-id scalar, so a retraction of one chat re-renders only the tab
 * rendering that chat.
 */
export function useEpicChatRetraction(
  chatId: string | null,
): ChatRecordRemovalReason | null {
  return useEpicStore((s) => {
    if (chatId === null) return null;
    if (Object.hasOwn(s.chatRetractions, chatId)) {
      return s.chatRetractions[chatId];
    }
    return null;
  });
}

/**
 * The host hosting a chat / terminal-agent row, read narrowly off the
 * `chats.byId` / `tuiAgents.byId` projection so a row "+" can inherit ITS OWN
 * host when spawning a child (Decision E). Returns `null` for artifact rows
 * (they carry no `hostId`), for legacy chats predating the field, and for
 * ids that resolve to nothing.
 *
 * Reads a single per-id scalar - NOT `TreeNode` (which has no `hostId`) and
 * NOT `useEpicArtifactRecords()` (whose array churns every token while a chat
 * streams). The selected string is reference-stable while unrelated rows
 * change, so the consuming row bails the render. See RENDER_PERF_INVARIANTS.md.
 */
export function useEpicNodeHostId(nodeId: string): string | null {
  return useEpicStore((s) => {
    if (Object.hasOwn(s.chats.byId, nodeId)) {
      return s.chats.byId[nodeId].hostId;
    }
    if (Object.hasOwn(s.tuiAgents.byId, nodeId)) {
      return s.tuiAgents.byId[nodeId].hostId;
    }
    return null;
  });
}

/**
 * The owning USER of a chat row, as a primitive for the same
 * churn-isolation reason as {@link useEpicNodeHostId}. Chat rows only:
 * the one consumer (the sidebar's unreachable-owner published-copy
 * routing) needs the cloud identity triple, which only chats have.
 */
export function useEpicNodeOwnerUserId(nodeId: string): string | null {
  return useEpicStore((s) => {
    if (Object.hasOwn(s.chats.byId, nodeId)) {
      return s.chats.byId[nodeId].userId;
    }
    return null;
  });
}

/**
 * Whether this node's record is archived, as a primitive so unrelated
 * projection churn cannot re-render the row. Covers both record kinds - one
 * `epic.setChatArchived` RPC keyed by id serves chats and terminal-agents
 * alike. Ids that resolve to neither map read as not archived.
 */
export function useEpicNodeArchived(nodeId: string): boolean {
  return useEpicStore((s) => {
    if (Object.hasOwn(s.chats.byId, nodeId)) {
      return s.chats.byId[nodeId].archivedAt !== null;
    }
    if (Object.hasOwn(s.tuiAgents.byId, nodeId)) {
      return s.tuiAgents.byId[nodeId].archivedAt !== null;
    }
    return false;
  });
}

/**
 * Provider-optional counterpart to {@link useEpicNodeArchived} for canvas tab
 * icons. The shared tab icon also renders in provider-less drag previews and
 * graph surfaces, so it resolves the epic through the session registry and
 * degrades to active when that epic has no mounted session.
 *
 * The selected boolean is narrow on purpose: streaming/title churn elsewhere
 * in the epic must not repaint every open tab.
 */
export function useRegisteredEpicNodeArchived(
  epicId: string,
  nodeId: string,
): boolean {
  const registry = getOpenEpicRegistry();
  const handle = useSyncExternalStore(
    (listener) => registry.subscribe(listener),
    () => registry.peek(epicId),
    () => null,
  );
  return useSyncExternalStore(
    (listener) => handle?.store.subscribe(listener) ?? noopSubscribe,
    () => liveEpicNodeArchivedFromHandle(handle, nodeId),
    () => false,
  );
}

function liveEpicNodeArchivedFromHandle(
  handle: OpenEpicStoreHandle | null,
  nodeId: string,
): boolean {
  if (handle === null) return false;
  const state = handle.store.getState();
  if (Object.hasOwn(state.chats.byId, nodeId)) {
    return state.chats.byId[nodeId].archivedAt !== null;
  }
  if (Object.hasOwn(state.tuiAgents.byId, nodeId)) {
    return state.tuiAgents.byId[nodeId].archivedAt !== null;
  }
  return false;
}

/**
 * A row's last-activity time, read from the CHAT / TERMINAL-AGENT PROJECTION
 * rather than from its `TreeNode`.
 *
 * The tree node carries an `updatedAt` too, and it is tempting to use since the
 * row already holds the node - but it is a lagging copy. `CHAT_TREE_KEYS` in
 * `epic-projector.ts` deliberately omits `updatedAt`, so touching a chat never
 * sets `structuralTreeDirty` and never rebuilds the tree; the node keeps
 * whatever `updatedAt` it had at the last STRUCTURAL change (rename, reparent,
 * create). Reading it made the sidebar row disagree with the hover card, which
 * self-sources the projection. Adding `updatedAt` to `CHAT_TREE_KEYS` would fix
 * the disagreement the wrong way round - it would rebuild the whole tree on
 * every message, which is precisely what that omission prevents.
 *
 * Selected as a primitive `number`, so `Object.is` still skips the render for
 * every unrelated projection change.
 */
export function useEpicNodeUpdatedAt(nodeId: string): number {
  return useEpicStore((s) => {
    if (Object.hasOwn(s.chats.byId, nodeId)) {
      return s.chats.byId[nodeId].updatedAt;
    }
    if (Object.hasOwn(s.tuiAgents.byId, nodeId)) {
      return s.tuiAgents.byId[nodeId].updatedAt;
    }
    return 0;
  });
}

/**
 * A GUI chat row's persisted harness id, selected as a primitive so unrelated
 * chat projection churn cannot re-render the sidebar icon. New chats normally
 * persist settings at creation; legacy or optimistic records can still have
 * no settings, in which case the caller keeps the generic chat glyph.
 */
export function useEpicChatHarnessId(nodeId: string): GuiHarnessId | null {
  return useEpicStore((s) => {
    if (!Object.hasOwn(s.chats.byId, nodeId)) return null;
    return s.chats.byId[nodeId].settings?.harnessId ?? null;
  });
}

/**
 * A terminal-agent row's harness id, read narrowly off `tuiAgents.byId` so a
 * tab / sidebar row can render the harness's brand icon (Claude, Codex, …) in
 * place of the generic bot glyph. Returns `null` for chat / artifact rows, for
 * ids that resolve to nothing, AND when called outside an open-epic session
 * (e.g. the drag overlay, which mounts at the app shell with no provider). In
 * every null case the caller falls back to the bot icon.
 *
 * Resolves through `useMaybeOpenEpicHandle` + `useSyncExternalStore` (the same
 * provider-optional pattern as the `useRegistered*` hooks above) so the single
 * `EpicNodeTabIcon` source can render it both inside the canvas tab strip and in
 * the provider-less overlay without a conditional hook call. The selected
 * harness id is a reference-stable primitive, so unrelated store churn does not
 * re-render the consuming row. See RENDER_PERF_INVARIANTS.md.
 */
export function useMaybeEpicTuiAgentHarnessId(
  nodeId: string,
): TuiHarnessId | null {
  const handle = useMaybeOpenEpicHandle();
  return useSyncExternalStore(
    (listener) => handle?.store.subscribe(listener) ?? noopSubscribe,
    () => {
      if (handle === null) return null;
      const s = handle.store.getState();
      return Object.hasOwn(s.tuiAgents.byId, nodeId)
        ? s.tuiAgents.byId[nodeId].harnessId
        : null;
    },
    () => null,
  );
}

export function useEpicNodeOwnerKind(
  nodeId: string,
): WorktreeBindingOwnerKind | null {
  return useEpicStore((s) => {
    if (Object.hasOwn(s.chats.byId, nodeId)) return "chat";
    if (Object.hasOwn(s.tuiAgents.byId, nodeId)) return "terminal-agent";
    return null;
  });
}

/**
 * A terminal-agent row's persisted `workspaceFolders` (the local paths it was
 * launched against), read narrowly off `tuiAgents.byId` so a row "+" can prefill
 * a nested terminal-agent's workspace from its PARENT (decision 16). Returns a
 * shared empty array for chat rows (`ChatProjection` carries no folders - prefill
 * gracefully falls back to the default workspace) and for ids that resolve to
 * nothing.
 *
 * The projection's `workspaceFolders` array is reference-stable until the agent's
 * folders actually change, so returning it directly does not churn the consuming
 * row's render; the empty fallback is the shared `EMPTY_ARRAY` for the same
 * reason. See RENDER_PERF_INVARIANTS.md.
 */
export function useEpicNodeWorkspaceFolders(nodeId: string): readonly string[] {
  return useEpicStore((s) => {
    if (Object.hasOwn(s.tuiAgents.byId, nodeId)) {
      return s.tuiAgents.byId[nodeId].workspaceFolders;
    }
    return EMPTY_ARRAY;
  });
}

export function useTreeNodeById(id: string | null): TreeNode | null {
  return useEpicStore((s) => {
    if (id === null) return null;
    if (Object.hasOwn(s.tree.nodeById, id)) return s.tree.nodeById[id];
    return null;
  });
}

export function useChildIdsOf(parentId: string): readonly string[] {
  return useEpicStore((s) =>
    Object.hasOwn(s.tree.childrenByParent, parentId)
      ? s.tree.childrenByParent[parentId]
      : EMPTY_ARRAY,
  );
}

export function useRootIdsAll(): readonly string[] {
  return useEpicStore((s) => s.tree.rootIds);
}

export function useEpicHeaderTitle(): string {
  return useEpicStore((s) => s.epic.title);
}

export { selectArtifacts, selectChats, selectTree };
