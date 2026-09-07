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

/** Chat-tile binding identity for the setup card. */
export interface SetupCardBinding {
  readonly epicId: string;
  readonly ownerId: string;
  readonly ownerKind: WorktreeBindingOwnerKind;
}

/**
 * One injectable transcript row carrying the consolidated setup-card view-model and its
 * `createdAt` sort key (mirrors `model.createdAt`).
 */
export interface SetupCardRow {
  readonly createdAt: number;
  /**
   * The window's position in the host's WHOLE-LOG partition - the value the card's row id is built
   * from, so it must be the host's and never this client's local index. See {@link alignToWholeLog}.
   */
  readonly windowIndex: number;
  readonly model: SetupCardViewModel;
  /**
   * True only for the lifecycle window still OPEN at the end of the walk - the live, current
   * lifecycle.
   */
  readonly isActive: boolean;
  /**
   * True when this lifecycle window holds a `setup.creating` event - i.e. the worktree creation was
   * announced LIVE during a conversation send.
   */
  readonly hasCreatingEvent: boolean;
  /**
   * The id of the user message whose send carried this worktree-creation intent, read from the
   * window's `setup.creating` event metadata.
   */
  readonly triggeringMessageId: string | null;
}

/**
 * Project the persisted `setup.*` chat events into the setup-card view-model. Pure - no store, no
 * React, no rendering.
 */
export function buildSetupCardRows(
  events: ReadonlyArray<ChatEvent>,
  binding: SetupCardBinding,
  /**
   * The host's whole-log partition, when this client is on the windowed line. Empty on the legacy
   * line, where `events` IS the whole log and the local partition is already authoritative.
   */
  wholeLogWindows: ReadonlyArray<SetupCardWindowIdentity>,
): ReadonlyArray<SetupCardRow> {
  const local = partitionSetupCardWindows(events);
  return alignToWholeLog(
    local,
    wholeLogWindows,
    observedBoundaries(events),
  ).map((aligned) => ({
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

/** The `worktree.missing` stamps this slice holds, ascending. */
function observedBoundaries(
  events: ReadonlyArray<ChatEvent>,
): ReadonlyArray<number> {
  return events
    .filter((event) => event.type === "worktree.missing")
    .map((event) => event.timestamp)
    .sort((left, right) => left - right);
}

/** One card to draw: whose lifecycle it is, and the events the slice holds. */
interface AlignedSetupCardWindow {
  readonly identity: SetupCardWindowIdentity;
  readonly events: ReadonlyArray<ChatEvent>;
  readonly triggeringMessageId: string | null;
}

/**
 * closedAt bounds the preceding window; null is a snapshot fact and does not mean join.
 * Tie is >= so an event stamped at closedAt is past the boundary.
 */
function belongsToPrecedingWindow(input: {
  readonly window: SetupCardWindow;
  readonly preceding: SetupCardWindowIdentity;
  readonly precedingBucketEmpty: boolean;
  /** Every `worktree.missing` stamp the slice holds, ascending. */
  readonly observedBoundaries: ReadonlyArray<number>;
}): boolean {
  const closedAt =
    input.preceding.closedAt ??
    // `?? undefined` rather than a `!== null` branch: a host that never sends the field and one that
    // sends `null` are both "no bound published", and an observed boundary answers for either.
    observedBoundaryClosing(
      input.preceding.createdAt,
      input.observedBoundaries,
    );
  // A KNOWN bound settles it outright, whether the host published it or the
  // slice supplied it. Without one, the empty-bucket inference is what is left.
  if (closedAt === undefined) return input.precedingBucketEmpty;
  return input.window.createdAt < closedAt;
}

/**
 * The earliest observed boundary that could have closed a lifecycle opened at `createdAt`, or
 * `undefined` when the slice holds none.
 */
function observedBoundaryClosing(
  createdAt: number,
  observedBoundaries: ReadonlyArray<number>,
): number | undefined {
  return observedBoundaries.find((boundary) => boundary >= createdAt);
}

/** Distribute one local window's events across the host windows it covers. */
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

/**
 * Re-attach the locally-partitioned windows to the host's whole-log partition. On the windowed
 * line `events` is a SLICE, so the local partition answers four questions wrongly and silently.
 */
function alignToWholeLog(
  local: ReadonlyArray<SetupCardWindow>,
  wholeLog: ReadonlyArray<SetupCardWindowIdentity>,
  observed: ReadonlyArray<number>,
): ReadonlyArray<AlignedSetupCardWindow> {
  if (wholeLog.length === 0) {
    // The legacy line: the host sent no list because `events` IS the whole log, so the local partition
    // is authoritative for the count and the flags alike.
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
    // A local window that matches no host `createdAt` is one of two very different things, and
    // treating both as "new" is what puts a card at the tail of the transcript.
    const orphanAnchor =
      !exactMatch &&
      cursor > 0 &&
      belongsToPrecedingWindow({
        window,
        preceding: wholeLog[cursor - 1],
        precedingBucketEmpty: held[cursor - 1].length === 0,
        observedBoundaries: observed,
      })
        ? cursor - 1
        : null;
    if (!exactMatch && orphanAnchor === null) {
      live.push(window);
      continue;
    }
    // This local window anchors here and may cover the host windows AFTER it too, when the boundaries
    // separating them are outside the slice - see {@link bucketWindowEvents}.
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

/** The id of the user message whose send carried this window's creation. */
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

/** Build one lifecycle window's consolidated VIEW MODEL. */
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
    // Mirror `isActive` onto the model so the component (which only receives the model) can tell a
    // live lifecycle from a stranded historical one without re-deriving it from the row state.
    isActive,
  };
}

function deriveWorkspace(
  workspacePath: string,
  groupEvents: ReadonlyArray<ChatEvent>,
): SetupCardWorkspace {
  // The host appends setup events in order, so the last one in array order is the workspace's
  // current state - a retry's `setup.running` lands after an earlier
  const latest = groupEvents[groupEvents.length - 1];
  const state = workspaceStateFor(latest.type);
  return {
    workspacePath,
    // The walk only admits events with a non-empty path, so the label is always a real folder name
    // (the card shows it as a secondary "· <folder>" detail).
    label: workspaceFolderName(workspacePath),
    state,
    // Only a `failed` state surfaces an exit code; the failing event carries it.
    setupExitCode:
      state === "failed" ? readMetadataNumber(latest, "setupExitCode") : null,
    // The failure reason the host stamped on the failing event (a provision failure's git error, or
    // null for a script failure - those surface the exit code + terminal instead).
    errorMessage:
      state === "failed" ? readMetadataString(latest, "errorMessage") : null,
    // A provision failure carries the exact folder intent it attempted, so Retry can re-provision via
    // `worktree.create`.
    retryFolderIntent:
      state === "failed" ? readRetryFolderIntent(latest) : null,
    terminalSessionId: latestMetadataString(groupEvents, "terminalSessionId"),
    // Where + what was created, for the expanded view.
    worktreePath: latestMetadataString(groupEvents, "worktreePath"),
    branch: latestMetadataString(groupEvents, "branch"),
  };
}

/** Parse the `folderIntent` a provision-failure `setup.failed` event carries. */
function readRetryFolderIntent(event: ChatEvent): WorktreeFolderIntent | null {
  const parsed = worktreeFolderIntentSchema.safeParse(
    readMetadataValue(event, "folderIntent"),
  );
  if (!parsed.success) return null;
  return parsed.data.kind === "worktree" ? parsed.data : null;
}

/** Newest-first non-empty read of a string metadata field across a workspace's events. */
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
 * Roll the per-workspace states up to one aggregate state, most-severe-first: a `failed` workspace
 * dominates (it owns the retry call-to-action), then any still-running `setting-up`, then any
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
