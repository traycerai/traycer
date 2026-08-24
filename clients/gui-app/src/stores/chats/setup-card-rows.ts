import type { ChatEvent } from "@traycer/protocol/persistence/epic/schemas";
import {
  worktreeFolderIntentSchema,
  type WorktreeBindingOwnerKind,
  type WorktreeFolderIntent,
} from "@traycer/protocol/host/worktree-schemas";
import {
  readMetadataNumber,
  readMetadataString,
  readMetadataValue,
} from "@/lib/chat/event-metadata";
// The lifecycle windowing is shared with the host, which reserves an ordinal
// per window - see `row-projection.ts`.
import { partitionSetupCardWindows } from "@traycer/protocol/persistence/chat-transcript/setup-card-windows";
import { workspaceFolderName } from "@/lib/worktree/workspace-folder-name";
import type {
  SetupCardViewModel,
  SetupCardWorkspace,
  SetupWorkspaceState,
} from "@/components/chat/segments/setup-card-segment";

/**
 * Chat-tile binding identity for the setup card. `epicId`/`ownerId`/`ownerKind`
 * are owned by the tile (not the events) - the old setup strip read them from
 * `chat-tile.tsx` props (`currentEpicId` / `node.id` / `"chat"`) and the deriver
 * takes them the same way so it can route the per-workspace retry mutation and
 * scope the terminal-liveness query.
 */
export interface SetupCardBinding {
  readonly epicId: string;
  readonly ownerId: string;
  readonly ownerKind: WorktreeBindingOwnerKind;
}

/**
 * One injectable transcript row carrying the consolidated setup-card view-model
 * and its `createdAt` sort key (mirrors `model.createdAt`). T3 merges this into
 * the `createdAt`-sorted message list; the explicit key keeps that merge from
 * reaching into the model.
 */
export interface SetupCardRow {
  readonly createdAt: number;
  readonly model: SetupCardViewModel;
  /**
   * True only for the lifecycle window still OPEN at the end of the walk - the
   * live, current lifecycle. A window closed by a boundary (`worktree.missing`
   * or a defensive ready->running re-bind) is historical: its row keeps
   * whatever state its last setup event left it in, which CAN be `setting-up`
   * when the worktree vanished mid-setup (the host emits no terminal setup
   * event for a missing-reset entry). Anything keying off "is setup in flight"
   * (e.g. suppressing the pre-turn indicator) must read this flag, not the row
   * state, so a stranded historical `setting-up` window never reads as active.
   */
  readonly isActive: boolean;
  /**
   * True when this lifecycle window holds a `setup.creating` event - i.e. the
   * worktree creation was announced LIVE during a conversation send. Only the
   * in-chat `materializeStagedWorktreeIntent` path emits `setup.creating` (right
   * before `git worktree add`), so such a window's `createdAt` is reliable: it is
   * stamped during the send, just before its triggering message persists, and
   * therefore sorts inline ABOVE that message by `createdAt`.
   *
   * A window WITHOUT a `setup.creating` event is the chat's INITIAL worktree, set
   * up out-of-band (epic-create / a catch-up back-fill at chat-attach, whose
   * `Date.now()` stamp can land AFTER the first message). Its `createdAt` is not
   * trustworthy for ordering, so the transcript pins it to the top - where the
   * genesis belongs - rather than letting a late stamp sink it below the first
   * message. This flag is what lets the renderer pin the genesis while leaving a
   * mid-chat first creation (window 0, but with a creating phase) inline.
   */
  readonly hasCreatingEvent: boolean;
  /**
   * The id of the user message whose send carried this worktree-creation intent,
   * read from the window's `setup.creating` event metadata. Non-null only for a
   * live mid-conversation creation (the in-chat send path stamps it); null for a
   * back-filled genesis window. The renderer anchors the card DIRECTLY above this
   * message by id rather than by `createdAt`: the card is announced before the
   * slow `git worktree add` while the message persists only AFTER it, so a
   * timestamp sort would order the card below the message and then jump it above
   * once the persisted message lands. Anchoring by id keeps the card pinned above
   * its message across the optimistic-echo -> persisted-message swap, no reorder.
   */
  readonly triggeringMessageId: string | null;
}

/**
 * Project the persisted `setup.*` chat events into the setup-card view-model.
 * Pure - no store, no React, no rendering. One row per setup *lifecycle*, in
 * chronological order, for the transcript merge.
 *
 * **The lifecycle WINDOWING is not here.** It moved to
 * `@traycer/protocol`'s `partitionSetupCardWindows`, because a setup card is a
 * transcript ROW: the host reserves an ordinal for it and must fold the same
 * events into the same number of windows. What stays here is the view model -
 * per-workspace state rollup, retry routing, terminal liveness - which the host
 * has no use for. That split is what let the windowing become shared code
 * without dragging component types into the protocol package.
 */
export function buildSetupCardRows(
  events: ReadonlyArray<ChatEvent>,
  binding: SetupCardBinding,
): ReadonlyArray<SetupCardRow> {
  return partitionSetupCardWindows(events).map((window) => ({
    createdAt: window.createdAt,
    isActive: window.isActive,
    hasCreatingEvent: window.hasCreatingEvent,
    triggeringMessageId: window.triggeringMessageId,
    model: deriveViewModel(
      window.events,
      binding,
      window.createdAt,
      window.isActive,
    ),
  }));
}

/**
 * Build one lifecycle window's consolidated VIEW MODEL.
 *
 * `createdAt` and `isActive` arrive from `partitionSetupCardWindows` rather
 * than being re-derived here - they are placement facts the host reads too, and
 * a second derivation of the window anchor is exactly the drift the shared
 * projection exists to prevent.
 */
function deriveViewModel(
  windowEvents: ReadonlyArray<ChatEvent>,
  binding: SetupCardBinding,
  createdAt: number,
  isActive: boolean,
): SetupCardViewModel {
  // Group by `workspacePath`, preserving first-seen order so the consolidated
  // card lists workspaces in the order their lifecycle began.
  const groups = new Map<string, ChatEvent[]>();
  for (const event of windowEvents) {
    const key = readMetadataString(event, "workspacePath") ?? "";
    const bucket = groups.get(key);
    if (bucket === undefined) {
      groups.set(key, [event]);
    } else {
      bucket.push(event);
    }
  }

  const workspaces = [...groups.entries()].map(([workspacePath, groupEvents]) =>
    deriveWorkspace(workspacePath, groupEvents),
  );

  return {
    aggregate: {
      epicId: binding.epicId,
      ownerId: binding.ownerId,
      ownerKind: binding.ownerKind,
      state: rollupState(workspaces),
    },
    workspaces,
    createdAt,
    // Mirror `isActive` onto the model so the component (which only receives the
    // model) can tell a live lifecycle from a stranded historical one without
    // re-deriving it from the row state.
    isActive,
  };
}

function deriveWorkspace(
  workspacePath: string,
  groupEvents: ReadonlyArray<ChatEvent>,
): SetupCardWorkspace {
  // The host appends setup events in order, so the last one in array order is
  // the workspace's current state - a retry's `setup.running` lands after an
  // earlier `setup.failed`/`setup.cancelled` and supersedes it (retry-in-place,
  // same consolidated card).
  const latest = groupEvents[groupEvents.length - 1];
  const state = workspaceStateFor(latest.type);
  return {
    workspacePath,
    // The old strip labelled each pill with `workspaceFolderName`; fold that in.
    // The walk only admits events with a non-empty path, so the label is always
    // a real folder name (the card shows it as a secondary "· <folder>" detail).
    label: workspaceFolderName(workspacePath),
    state,
    // Only a `failed` state surfaces an exit code; the failing event carries it.
    setupExitCode:
      state === "failed" ? readMetadataNumber(latest, "setupExitCode") : null,
    // The failure reason the host stamped on the failing event (a provision
    // failure's git error, or null for a script failure - those surface the
    // exit code + terminal instead).
    errorMessage:
      state === "failed" ? readMetadataString(latest, "errorMessage") : null,
    // A provision failure carries the exact folder intent it attempted, so
    // Retry can re-provision via `worktree.create`. Schema-validated: an
    // older event without it (or a malformed value) resolves to null and
    // Retry falls back to `worktree.retrySetup`.
    retryFolderIntent:
      state === "failed" ? readRetryFolderIntent(latest) : null,
    terminalSessionId: latestMetadataString(groupEvents, "terminalSessionId"),
    // Where + what was created, for the expanded view. Carried on every setup.*
    // event now, but read newest-first non-empty so a workspace inherits it even
    // if some event omitted it (older events predate this metadata).
    worktreePath: latestMetadataString(groupEvents, "worktreePath"),
    branch: latestMetadataString(groupEvents, "branch"),
  };
}

/**
 * Parse the `folderIntent` a provision-failure `setup.failed` event carries.
 * Only a `worktree`-kind intent is retryable through `worktree.create`; a
 * missing/malformed value (older hosts) yields null and the caller falls back
 * to the script-retry path.
 */
function readRetryFolderIntent(event: ChatEvent): WorktreeFolderIntent | null {
  const parsed = worktreeFolderIntentSchema.safeParse(
    readMetadataValue(event, "folderIntent"),
  );
  if (!parsed.success) return null;
  return parsed.data.kind === "worktree" ? parsed.data : null;
}

/**
 * Newest-first non-empty read of a string metadata field across a workspace's
 * events. Used for `terminalSessionId` (only `running`/`failed`/`cancelled`
 * carry it, not `succeeded`, so a ready workspace inherits it from its earlier
 * `running` event) and for `worktreePath`/`branch`. A retry's fresh value wins
 * over a prior lifecycle's because the scan starts at the latest event.
 */
function latestMetadataString(
  groupEvents: ReadonlyArray<ChatEvent>,
  key: string,
): string | null {
  for (let index = groupEvents.length - 1; index >= 0; index -= 1) {
    const value = readMetadataString(groupEvents[index], key);
    if (value !== null && value.length > 0) return value;
  }
  return null;
}

function workspaceStateFor(type: ChatEvent["type"]): SetupWorkspaceState {
  switch (type) {
    case "setup.creating":
      // `git worktree add` is in flight (emitted before the add starts). The
      // card shows the "Creating worktree" step spinning, "Setting up" pending.
      return "creating";
    case "setup.succeeded":
      return "ready";
    case "setup.failed":
      return "failed";
    case "setup.cancelled":
      return "cancelled";
    // `setup.running` (and any non-setup type, which `buildSetupCardRows`
    // filters out before this is reached) maps to the script-running state.
    default:
      return "setting-up";
  }
}

/**
 * Roll the per-workspace states up to one aggregate state, most-severe-first:
 * a `failed` workspace dominates (it owns the retry call-to-action), then any
 * still-running `setting-up`, then any still-`creating` worktree (both are work
 * in flight; `setting-up` is further along so it wins the header), then
 * `cancelled` (paused, recoverable), and only when every workspace is `ready`
 * does the card read `ready`.
 */
export function rollupState(
  workspaces: ReadonlyArray<SetupCardWorkspace>,
): SetupWorkspaceState {
  if (workspaces.some((workspace) => workspace.state === "failed")) {
    return "failed";
  }
  if (workspaces.some((workspace) => workspace.state === "setting-up")) {
    return "setting-up";
  }
  if (workspaces.some((workspace) => workspace.state === "creating")) {
    return "creating";
  }
  if (workspaces.some((workspace) => workspace.state === "cancelled")) {
    return "cancelled";
  }
  return "ready";
}
