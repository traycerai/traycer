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
import { SETUP_EVENT_TYPES } from "@/lib/chat/setup-tone";
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
 * Project the persisted `setup.*` chat events into the setup-card view-model
 * (T1's contract). Pure - no store, no React, no rendering. Returns one row per
 * setup *lifecycle*, in chronological (createdAt-ascending) order, for T3 to
 * merge into the createdAt-sorted transcript.
 *
 * A chat log can hold MORE than one lifecycle. A retry updates a workspace in
 * place (same lifecycle, same row), but a same-host re-bind appends a fresh
 * `setup.running` to the SAME log after the prior worktree went missing - the
 * old card must stay `ready` and a NEW card must appear at the re-bind moment,
 * not flip the old one back to `setting-up`. (A cross-host re-bind clones the
 * chat artifact, so that case never reaches one log.)
 *
 * So the walk partitions `events` (in append/chronological order) into lifecycle
 * windows, splitting on:
 *  - `worktree.missing` - the primary boundary: the worktree was reset, so the
 *    next setup belongs to a new lifecycle (covers re-bind to a different path).
 *  - a `setup.running` for a workspace the current window already saw `succeeded`
 *    - a defensive ready->running boundary for any re-bind that didn't emit
 *    `worktree.missing`. A `failed`/`cancelled`->`running` retry has no such
 *    boundary, so it stays in-place within the same window and supersedes.
 *
 * Each non-empty window becomes one consolidated row with one `SetupCardWorkspace`
 * per `workspacePath`, anchored at that window's earliest setup-event timestamp.
 * The final window is flagged `isActive` only when no boundary closed it (it is
 * the live lifecycle); every earlier window, and a final one closed by a trailing
 * boundary, is historical.
 */
export function buildSetupCardRows(
  events: ReadonlyArray<ChatEvent>,
  binding: SetupCardBinding,
): ReadonlyArray<SetupCardRow> {
  const windows: ChatEvent[][] = [];
  let current: ChatEvent[] | null = null;

  for (const event of events) {
    // `worktree.missing` is the lifecycle boundary: it isn't a setup event
    // itself, but it marks the binding reset that separates two lifecycles.
    if (event.type === "worktree.missing") {
      current = null;
      continue;
    }
    if (!SETUP_EVENT_TYPES.has(event.type)) continue;

    // A path-less setup event (e.g. the generic `SETUP_AWAIT_FAILED` catch) can
    // neither name a workspace nor drive its retry, so it never forms or affects
    // a window. The per-workspace typed failure carries its own `workspacePath`.
    const workspacePath = readMetadataString(event, "workspacePath");
    if (workspacePath === null || workspacePath.length === 0) continue;

    // Lifecycle boundary: a NEW worktree creation must open its own window so its
    // card renders near the message that triggered it, never folding into an
    // earlier card. Close the current window when:
    //  - `setup.running` arrives for a path the window already marked `succeeded`
    //    (a defensive re-bind that skipped `worktree.missing`).
    //  - `setup.creating` arrives once the window has moved past its initial
    //    creating phase, i.e. it already holds a non-creating setup event
    //    (`windowHasProgressedPastCreating`). That marks a SEPARATE create send -
    //    including one targeting a different workspace than the window's. The
    //    consecutive `setup.creating` events of ONE multi-worktree send are all
    //    emitted BEFORE any `setup.running` (see `materializeStagedWorktreeIntent`),
    //    so they still consolidate into a single window.
    //  - `setup.creating` repeats for a path already `creating` in the window
    //    (the first create attempt was abandoned before it ran).
    if (
      current !== null &&
      ((event.type === "setup.running" &&
        windowHasSucceeded(current, workspacePath)) ||
        (event.type === "setup.creating" &&
          (windowHasProgressedPastCreating(current) ||
            windowHasCreating(current, workspacePath))))
    ) {
      current = null;
    }

    if (current === null) {
      current = [];
      windows.push(current);
    }
    current.push(event);
  }

  // `current` is non-null only when the final window is still open (no closing
  // boundary followed its last setup event), and it always references that
  // last-pushed window - so an identity check marks exactly the one live
  // lifecycle active. A historical window stranded at `setting-up` (worktree
  // vanished mid-setup, no terminal setup event) is therefore NOT active.
  return windows.map((windowEvents) =>
    deriveRow(windowEvents, binding, windowEvents === current),
  );
}

/**
 * True once the window holds a setup event PAST its initial creating phase - any
 * `setup.running`/`succeeded`/`failed`/`cancelled`. A fresh `setup.creating`
 * arriving after this point belongs to a SEPARATE create send and must open a new
 * window. The consecutive `setup.creating` events of ONE multi-worktree send all
 * arrive before any such event, so they still consolidate into one window.
 */
function windowHasProgressedPastCreating(
  windowEvents: ReadonlyArray<ChatEvent>,
): boolean {
  return windowEvents.some((event) => event.type !== "setup.creating");
}

/**
 * True when this lifecycle window already holds a `setup.creating` for the
 * workspace - i.e. a create was already announced for it before this one.
 */
function windowHasCreating(
  windowEvents: ReadonlyArray<ChatEvent>,
  workspacePath: string,
): boolean {
  return windowEvents.some(
    (event) =>
      event.type === "setup.creating" &&
      readMetadataString(event, "workspacePath") === workspacePath,
  );
}

function windowHasSucceeded(
  windowEvents: ReadonlyArray<ChatEvent>,
  workspacePath: string,
): boolean {
  return windowEvents.some(
    (event) =>
      event.type === "setup.succeeded" &&
      readMetadataString(event, "workspacePath") === workspacePath,
  );
}

/**
 * Build one consolidated row from a single lifecycle window's setup events
 * (every event already filtered to a setup type carrying a non-empty path).
 */
function deriveRow(
  windowEvents: ReadonlyArray<ChatEvent>,
  binding: SetupCardBinding,
  isActive: boolean,
): SetupCardRow {
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

  // Anchor the row at the genesis of THIS lifecycle: the earliest setup-event
  // timestamp in the window. This is the transcript sort key and the live
  // elapsed counter's seed. Use the min timestamp (not array position) so
  // out-of-order arrivals still anchor deterministically at the true start.
  const createdAt = windowEvents.reduce(
    (earliest, event) => Math.min(earliest, event.timestamp),
    windowEvents[0].timestamp,
  );

  // The window's `setup.creating` event (if any) is emitted ONLY by the in-chat
  // send path. Resolve it once and derive both signals from it:
  //  - `hasCreatingEvent` (its PRESENCE) marks a live mid-conversation creation
  //    (reliable `createdAt`) vs the chat's back-filled genesis worktree, and
  //    drives the genesis-pin discriminator.
  //  - `triggeringMessageId` (the ID it carries) drives the transcript anchor.
  // These are intentionally distinct, not redundant: a creating event missing
  // its id (a defensive shape the host never emits today) still marks a
  // mid-chat creation (so it must NOT pin as genesis) yet has no anchor target
  // (so it floats by `createdAt`). Pinning on presence and anchoring on the id
  // keeps that case correct. Every creating event in a window is from the same
  // send, so `.find` (first match) is authoritative. See the field docs above.
  const creatingEvent = windowEvents.find(
    (event) => event.type === "setup.creating",
  );
  const hasCreatingEvent = creatingEvent !== undefined;
  const triggeringMessageId =
    creatingEvent === undefined
      ? null
      : readMetadataString(creatingEvent, "triggeringMessageId");

  const model: SetupCardViewModel = {
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
  return { createdAt, model, isActive, hasCreatingEvent, triggeringMessageId };
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
