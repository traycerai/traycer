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
import {
  partitionSetupCardWindows,
  type SetupCardWindow,
} from "@traycer/protocol/persistence/chat-transcript/setup-card-windows";
import type { SetupCardWindowIdentity } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
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
  /**
   * The window's position in the host's WHOLE-LOG partition - the value the
   * card's row id is built from, so it must be the host's and never this
   * client's local index. See {@link alignToWholeLog}.
   */
  readonly windowIndex: number;
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
  /**
   * The host's whole-log partition, when this client is on the windowed line.
   * Empty on the legacy line, where `events` IS the whole log and the local
   * partition is already authoritative. See {@link alignToWholeLog}.
   */
  wholeLogWindows: ReadonlyArray<SetupCardWindowIdentity>,
): ReadonlyArray<SetupCardRow> {
  const local = partitionSetupCardWindows(events);
  return alignToWholeLog(local, wholeLogWindows).map((aligned) => ({
    createdAt: aligned.identity.createdAt,
    windowIndex: aligned.identity.windowIndex,
    isActive: aligned.identity.isActive,
    hasCreatingEvent: aligned.identity.hasCreatingEvent,
    triggeringMessageId: aligned.triggeringMessageId,
    model: deriveViewModel(
      aligned.events,
      binding,
      aligned.identity.createdAt,
      aligned.identity.isActive,
    ),
  }));
}

/** One card to draw: whose lifecycle it is, and the events the slice holds. */
interface AlignedSetupCardWindow {
  readonly identity: SetupCardWindowIdentity;
  readonly events: ReadonlyArray<ChatEvent>;
  readonly triggeringMessageId: string | null;
}

/**
 * Re-attach the locally-partitioned windows to the host's whole-log partition.
 *
 * On the windowed line `events` is a SLICE, so the local partition answers four
 * questions wrongly and silently. Three are per-window flags: the first window
 * it can see is numbered 0 whatever its real position, a historically closed
 * window looks active because the `worktree.missing` boundary that closed it is
 * outside the slice, and a genesis window can lose its `setup.creating` the
 * same way. The renumber is the worst of those, because `windowIndex` is part
 * of the card's ROW ID - the card then computes an id the skeleton never
 * published, its ordinal is suppressed, and it draws unplaced at the tail.
 *
 * The fourth is the COUNT, and no per-window correction can reach it. That same
 * absent `worktree.missing` does not merely mislabel a window, it MERGES two:
 * the boundary is not a setup event, so a slice that dropped it partitions two
 * lifecycles into one. One card is then drawn for two reserved ordinals, and
 * the second reads to the row merge as a row renderer policy withheld
 * (`transcript-list-rows.ts`) rather than one nobody built - so it silently
 * renders nothing at all, with no placeholder either.
 *
 * Hence the host's list decides HOW MANY cards exist, and the slice supplies
 * only their contents. A merged local window is re-split across the host's own
 * anchors; the events are all present, only the boundary between them was
 * missing.
 *
 * ## Which local window belongs to which host window
 *
 * Matched on `createdAt` walking both lists in order, which is sound because
 * both are chronological and the local one is a SUBSEQUENCE of the host's.
 * Walking rather than a map lookup is what makes two lifecycles stamped in the
 * same millisecond map one-to-one instead of both resolving to the first.
 *
 * Being a subsequence does NOT make the timestamps agree, and assuming it did
 * was a defect. A local window anchors at the earliest event the SLICE holds,
 * which is the host's own `createdAt` only when the slice reaches back that
 * far. A live setup event for a lifecycle whose opening is still cold gives a
 * window stamped later than the host's, matching nothing - so the equality test
 * needs a second answer for "no match", below.
 *
 * ## Two deliberate asymmetries
 *
 * A host window the slice holds NO events for draws no card. That is the
 * ordinary cold card - its row is unhydrated, so the transcript wants the
 * skeleton placeholder there, and a card built from no events would replace a
 * "loading" row with a permanently blank one.
 *
 * A local window the host's list does not name draws one anyway, numbered past
 * the end of that list. That is the genuinely new lifecycle whose events
 * arrived as live deltas after the last snapshot: the host has not published it
 * yet, and its next partition will append it at exactly that index. It is
 * recognised by sitting after a host window the slice DID supply; one sitting
 * after an EMPTY host window is that window's cold-opening tail instead, and is
 * anchored to it rather than numbered past the end.
 */
/**
 * Distribute one local window's events across the host windows it covers.
 *
 * Extracted from {@link alignToWholeLog} rather than inlined, because the two
 * are different questions - which host window a local one anchors at, and where
 * each of its events lands - and keeping them in one body put that function
 * over the complexity ceiling. Returns the FURTHEST host window reached, which
 * is where the caller's forward cursor resumes.
 *
 * Each event goes to the last host window that had started by the time it was
 * stamped, never earlier than the anchor. A host window stamped in the SAME
 * millisecond as the anchor cannot take anything, and that guard is
 * load-bearing rather than defensive: without it the anchor's own earliest
 * event - the one whose timestamp IS the anchor - would shift to the sibling,
 * leaving the anchor with an empty bucket and drawing no card for it at all.
 * Two lifecycles a millisecond apart have no timestamp boundary to be split on,
 * so that pair stays merged exactly as it was before this alignment existed,
 * which is a degradation and not a loss.
 */
function bucketWindowEvents(input: {
  readonly window: SetupCardWindow;
  readonly wholeLog: ReadonlyArray<SetupCardWindowIdentity>;
  readonly anchor: number;
  readonly held: ChatEvent[][];
}): number {
  const { window, wholeLog, anchor, held } = input;
  const anchoredAt = wholeLog[anchor].createdAt;
  let furthest = anchor;
  for (const event of window.events) {
    let target = anchor;
    while (
      target + 1 < wholeLog.length &&
      wholeLog[target + 1].createdAt <= event.timestamp &&
      wholeLog[target + 1].createdAt > anchoredAt
    ) {
      target += 1;
    }
    held[target].push(event);
    if (target > furthest) furthest = target;
  }
  return furthest;
}

function alignToWholeLog(
  local: ReadonlyArray<SetupCardWindow>,
  wholeLog: ReadonlyArray<SetupCardWindowIdentity>,
): ReadonlyArray<AlignedSetupCardWindow> {
  if (wholeLog.length === 0) {
    // The legacy line: the host sent no list because `events` IS the whole log,
    // so the local partition is authoritative for the count and the flags
    // alike.
    return local.map((window, index) => ({
      identity: {
        createdAt: window.createdAt,
        windowIndex: index,
        isActive: window.isActive,
        hasCreatingEvent: window.hasCreatingEvent,
      },
      events: window.events,
      triggeringMessageId: window.triggeringMessageId,
    }));
  }

  const held: ChatEvent[][] = wholeLog.map(() => []);
  const live: SetupCardWindow[] = [];
  let cursor = 0;
  for (const window of local) {
    while (
      cursor < wholeLog.length &&
      wholeLog[cursor].createdAt < window.createdAt
    ) {
      cursor += 1;
    }
    const exactMatch =
      cursor < wholeLog.length &&
      wholeLog[cursor].createdAt === window.createdAt;
    // A local window that matches no host `createdAt` is one of two very
    // different things, and treating both as "new" is what puts a card at the
    // tail of the transcript.
    //
    // The subsequence argument above holds only while the slice contains the
    // lifecycle's EARLIEST event. It need not: `onEventAppended` seats a live
    // setup event in `liveEvents`, and `hydratedRecords` publishes it straight
    // away, so a lifecycle whose opening events are still cold is partitioned
    // locally from its LATER events alone - and stamps the window at their
    // timestamp, which is past the host's.
    //
    // The two cases look identical in this function's INPUTS, so the
    // discriminator is what the walk has already done: whether the host window
    // just behind this one still has no events at all. A genuinely new
    // lifecycle sits after a host window the slice DID supply (that is what
    // moved the cursor past it), while a cold-opening tail sits after the very
    // window it belongs to - which is empty precisely because its events are
    // the ones that did not arrive. The cursor only moves forward, so an empty
    // bucket here can no longer be filled by anything else.
    //
    // Not `hasCreatingEvent`: a lifecycle can legitimately open on
    // `setup.running`, so its absence does not mean the opening is missing.
    const orphanAnchor =
      !exactMatch && cursor > 0 && held[cursor - 1].length === 0
        ? cursor - 1
        : null;
    if (!exactMatch && orphanAnchor === null) {
      live.push(window);
      continue;
    }
    // This local window anchors here and may cover the host windows AFTER it
    // too, when the boundaries separating them are outside the slice - see
    // {@link bucketWindowEvents}.
    const anchor = exactMatch ? cursor : (orphanAnchor ?? cursor);
    cursor = bucketWindowEvents({ window, wholeLog, anchor, held }) + 1;
  }

  const fromHost = wholeLog.flatMap<AlignedSetupCardWindow>(
    (identity, index) => {
      const windowEvents = held[index];
      if (windowEvents.length === 0) return [];
      return [
        {
          identity,
          events: windowEvents,
          triggeringMessageId: triggeringMessageIdOf(windowEvents),
        },
      ];
    },
  );
  return [
    ...fromHost,
    ...live.map((window, offset) => ({
      identity: {
        createdAt: window.createdAt,
        windowIndex: wholeLog.length + offset,
        isActive: window.isActive,
        hasCreatingEvent: window.hasCreatingEvent,
      },
      events: window.events,
      triggeringMessageId: window.triggeringMessageId,
    })),
  ];
}

/**
 * The id of the user message whose send carried this window's creation.
 *
 * Re-read here rather than carried over from the local window, because a local
 * window re-split across two host anchors has one `setup.creating` per half and
 * the merged window's answer is only ever the first half's. Same rule
 * `describeWindow` states: every creating event in a window comes from the same
 * send, so the first match is authoritative.
 */
function triggeringMessageIdOf(
  windowEvents: ReadonlyArray<ChatEvent>,
): string | null {
  const creating = windowEvents.find(
    (event) => event.type === "setup.creating",
  );
  return creating === undefined
    ? null
    : readMetadataString(creating, "triggeringMessageId");
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
